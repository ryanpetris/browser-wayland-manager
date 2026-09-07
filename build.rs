fn main() {
    println!("cargo:rerun-if-env-changed=INNKEEPER_VERSION");
    println!("cargo:rerun-if-changed=build.rs");
    let version = std::env::var("INNKEEPER_VERSION")
        .unwrap_or_else(|_| format!("{}-dev", env!("CARGO_PKG_VERSION")));
    println!("cargo:rustc-env=INNKEEPER_VERSION={version}");
}
