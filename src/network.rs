use crate::{App, Result, Session, docker, env};
use anyhow::{Context, bail};
use std::net::{IpAddr, SocketAddr};

pub struct Network {
    pub id: Option<String>,
    pub rtc_addr: IpAddr,
}
impl Network {
    pub async fn discover() -> Result<Self> {
        let mut in_docker = env("INNKEEPER_IN_DOCKER", "0") == "1";
        let mut container = env("INNKEEPER_DOCKER_CONTAINER", "");
        let mut network = env("INNKEEPER_DOCKER_NETWORK", "");
        let mut args = std::env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--in-docker" => in_docker = true,
                "--docker-container" => {
                    container = args
                        .next()
                        .context("--docker-container needs a container name or ID")?
                }
                "--docker-network" => {
                    network = args
                        .next()
                        .context("--docker-network needs a network name or ID")?
                }
                _ => bail!("Unknown argument: {arg}"),
            }
        }
        let rtc_addr: IpAddr = env("INNKEEPER_RTC_ADDR", "")
            .parse()
            .context("Set INNKEEPER_RTC_ADDR to the IPv4 address browsers can reach for WebRTC")?;
        if !rtc_addr.is_ipv4() || rtc_addr.is_unspecified() || rtc_addr.is_multicast() {
            bail!("INNKEEPER_RTC_ADDR must be a reachable unicast IPv4 address");
        }
        if !in_docker {
            if !container.is_empty() || !network.is_empty() {
                bail!("Docker network options require --in-docker");
            }
            return Ok(Self { id: None, rtc_addr });
        }
        if container.is_empty() {
            container = std::fs::read_to_string("/etc/hostname")
                .context("Read container hostname")?
                .trim()
                .into();
        }
        let info: serde_json::Value = serde_json::from_str(&docker(&["inspect", "--type", "container", &container]).await
            .context("Cannot identify Innkeeper's container; set INNKEEPER_DOCKER_CONTAINER to its name or ID")?)?;
        let networks = info[0]["NetworkSettings"]["Networks"]
            .as_object()
            .context("Container has no networks")?;
        let mut eligible = Vec::new();
        for (name, config) in networks {
            let id = config["NetworkID"].as_str().context("Missing network ID")?;
            let details: serde_json::Value =
                serde_json::from_str(&docker(&["network", "inspect", id]).await?)?;
            if details[0]["Driver"] == "bridge"
                && (network.is_empty() || network == *name || network == id)
            {
                eligible.push(id.to_owned());
            }
        }
        if eligible.len() != 1 {
            bail!(
                "Select one attached bridge network with INNKEEPER_DOCKER_NETWORK (found {} matching networks)",
                eligible.len()
            );
        }
        Ok(Self {
            id: eligible.pop(),
            rtc_addr,
        })
    }
}
impl App {
    pub async fn backend(&self, s: &Session) -> Result<SocketAddr> {
        let info = self.owned(&s.id).await?;
        if info["State"]["Running"] != true {
            bail!("Session is not running");
        }
        match &self.network.id {
            None => Ok(SocketAddr::from(([127, 0, 0, 1], s.port))),
            Some(id) => {
                let networks = info["NetworkSettings"]["Networks"]
                    .as_object()
                    .context("Session has no networks")?;
                let entry = networks
                    .values()
                    .find(|n| n["NetworkID"].as_str() == Some(id))
                    .context("Session is not on Innkeeper's network")?;
                let ip: IpAddr = entry["IPAddress"]
                    .as_str()
                    .context("Missing session IP")?
                    .parse()
                    .context("Invalid session IP")?;
                if ip.is_unspecified() {
                    bail!("Session has no assigned IP");
                }
                Ok(SocketAddr::new(ip, 19443))
            }
        }
    }
    pub async fn endpoint(&self, s: &Session) -> Result<String> {
        Ok(format!("http://{}/e/{}", self.backend(s).await?, s.id))
    }
}
