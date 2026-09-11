use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    os::unix::fs::{FileTypeExt, MetadataExt},
    path::Path,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Gpu {
    pub id: String,
    pub driver: String,
    pub node: String,
    pub major: u32,
    pub minor: u32,
}

fn inspect(node: &Path) -> Result<Gpu> {
    let metadata = fs::metadata(node)?;
    ensure!(metadata.file_type().is_char_device(), "Not a GPU device");
    let major = libc::major(metadata.rdev());
    let minor = libc::minor(metadata.rdev());
    let device = fs::canonicalize(format!("/sys/dev/char/{major}:{minor}/device"))?;
    let driver = fs::canonicalize(device.join("driver"))?;
    let name = |path: &Path| -> Result<String> {
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .context("Invalid GPU identity")?;
        ensure!(
            name.bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(&c)),
            "Invalid GPU identity"
        );
        Ok(name.to_owned())
    };
    Ok(Gpu {
        id: name(&device)?,
        driver: name(&driver)?,
        node: node.to_str().context("Invalid GPU path")?.into(),
        major,
        minor,
    })
}

pub fn discover() -> (Vec<Gpu>, Vec<String>) {
    let mut devices = vec![];
    let mut errors = vec![];
    if let Ok(entries) = fs::read_dir("/dev/dri") {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(suffix) = name.to_str().and_then(|s| s.strip_prefix("renderD")) else {
                continue;
            };
            if suffix.is_empty() || !suffix.bytes().all(|c| c.is_ascii_digit()) {
                continue;
            }
            match inspect(&entry.path()) {
                Ok(device) => devices.push(device),
                Err(error) => errors.push(format!(
                    "Cannot identify {}: {error:#}. Check host device and sysfs access.",
                    entry.path().display()
                )),
            }
        }
    }
    devices.sort_by_key(|g| (g.major, g.minor));
    (devices, errors)
}

pub fn select(devices: &[Gpu], access: bool, id: Option<&str>) -> Result<Option<Gpu>> {
    ensure!(access || id.is_none(), "GPU selection requires GPU access");
    if !access {
        return Ok(None);
    }
    let selected = match id {
        Some(id) => devices.iter().find(|gpu| gpu.id == id),
        None => devices.first(),
    };
    Ok(Some(
        selected
            .context("Selected GPU is unavailable. Check host devices and sysfs access.")?
            .clone(),
    ))
}

impl Gpu {
    pub fn validate(&self) -> Result<()> {
        let (devices, _) = discover();
        let current = devices.iter().find(|g| g.id == self.id).context(
            "Selected GPU is unavailable. Restore the device, then Stop and Start this session.",
        )?;
        ensure!(
            current == self,
            "Selected GPU's driver or device mapping changed. Create a new session for this GPU."
        );
        Ok(())
    }

    pub fn nvidia(&self) -> bool {
        self.driver == "nvidia"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selection() {
        let intel = Gpu {
            id: "0000:00:02.0".into(),
            driver: "i915".into(),
            node: "/dev/dri/renderD128".into(),
            major: 226,
            minor: 128,
        };
        let nvidia = Gpu {
            id: "0000:01:00.0".into(),
            driver: "nvidia".into(),
            node: "/dev/dri/renderD129".into(),
            major: 226,
            minor: 129,
        };
        let devices = vec![intel.clone(), nvidia.clone()];
        assert_eq!(select(&devices, true, None).unwrap(), Some(intel));
        assert_eq!(
            select(&devices, true, Some(&nvidia.id)).unwrap(),
            Some(nvidia)
        );
        assert!(select(&devices, true, Some("/etc/passwd")).is_err());
        assert!(select(&[], true, None).is_err());
        assert!(select(&devices, false, Some("0000:01:00.0")).is_err());
        assert_eq!(select(&devices, false, None).unwrap(), None);
    }
}
