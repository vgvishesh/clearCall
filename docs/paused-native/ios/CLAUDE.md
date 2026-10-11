# ios/ — Swift 6 / SwiftUI
Load the `ios-dev` skill before working here. Key rules:
- `project.yml` (XcodeGen) is the project source of truth; `make ios-gen` regenerates. Never edit `*.xcodeproj`.
- Configurations: Debug, QA (test media injection + stats export + qa deep links), Release. QA code lives behind `#if QA` and is never compiled into Release.
- Layout: `App/`, `Features/<Name>/`, `Call/`, `Media/`, `Signaling/`, `Identity/`, `Tests/` (incl. `ProtocolConformanceTests` reading `../protocol/fixtures`).
- Dependencies via SPM only (declared in project.yml). Adding one needs a one-line justification in the plan.
- Min iOS 17 (proposed). Bundle id `com.example.clearcall` (placeholder).
