use std::{env, process::Command};

fn main() {
    println!("cargo:rerun-if-env-changed=INNKEEPER_VERSION");
    println!("cargo:rerun-if-changed=build.rs");
    for directory in ["--git-dir", "--git-common-dir"] {
        if let Ok(output) = Command::new("git").args(["rev-parse", directory]).output() {
            if output.status.success() {
                println!(
                    "cargo:rerun-if-changed={}",
                    String::from_utf8_lossy(&output.stdout).trim()
                );
            }
        }
    }
    let version = env::var("INNKEEPER_VERSION")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            Command::new("git")
                .args(["describe", "--tags", "--match", "v[0-9]*"])
                .output()
                .ok()
                .filter(|output| output.status.success())
                .and_then(|output| String::from_utf8(output.stdout).ok())
        })
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").into());
    println!(
        "cargo:rustc-env=INNKEEPER_VERSION={}",
        version.trim().trim_start_matches('v')
    );
}
