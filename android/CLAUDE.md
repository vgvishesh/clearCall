# android/ — Kotlin / Jetpack Compose
Load the `android-dev` skill before working here. Key rules:
- Gradle Kotlin DSL; every dependency/version in `gradle/libs.versions.toml`. JDK 21 toolchain.
- Build types/flavors: debug, qa (test media injection + stats export + qa deep links), release. QA code in `src/qa/` only.
- Packages: `app`, `feature.*`, `call`, `media`, `signaling`, `identity`; tests incl. `ProtocolConformanceTest` reading `../protocol/fixtures`.
- minSdk 26 (proposed), targetSdk latest. applicationId `com.example.clearcall` (placeholder).
- ktlint is enforced by hooks; keep Compose previews for every screen (they double as screenshot tests later).
