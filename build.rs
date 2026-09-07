fn main() {
    println!("cargo:rerun-if-env-changed=INNKEEPER_VERSION");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=Cargo.toml");
    let manifest: toml::Table = std::fs::read_to_string("Cargo.toml")
        .expect("read Cargo.toml")
        .parse()
        .expect("parse Cargo.toml");
    let elsewhere_version = manifest["package"]["metadata"]["elsewhere"]["version"]
        .as_str()
        .expect("package.metadata.elsewhere.version must be a string");
    println!("cargo:rustc-env=ELSEWHERE_VERSION={elsewhere_version}");
    let version = std::env::var("INNKEEPER_VERSION")
        .unwrap_or_else(|_| format!("{}-dev", env!("CARGO_PKG_VERSION")));
    println!("cargo:rustc-env=INNKEEPER_VERSION={version}");
}
