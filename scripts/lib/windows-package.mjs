const WINDOWS_ARCHITECTURE_DEFINITIONS = Object.freeze({
  arm64: Object.freeze({
    name: "arm64",
    peMachine: 0xaa64,
    peMachineHex: "0xAA64"
  }),
  x64: Object.freeze({
    name: "x64",
    peMachine: 0x8664,
    peMachineHex: "0x8664"
  })
});

export const WINDOWS_ARCHITECTURES = Object.freeze(Object.keys(WINDOWS_ARCHITECTURE_DEFINITIONS));

export function getWindowsArchitecture(name) {
  const architecture = WINDOWS_ARCHITECTURE_DEFINITIONS[name];
  if (!architecture) {
    throw new Error(`Unsupported Windows architecture: ${name}. Expected arm64 or x64.`);
  }
  return architecture;
}

export function parseWindowsArchitectures(args, { defaultArchitecture = process.arch, allowAll = true } = {}) {
  const values = args
    .filter((argument) => argument.startsWith("--arch="))
    .map((argument) => argument.slice("--arch=".length));
  if (values.length > 1) throw new Error("Specify --arch only once.");
  const requested = values[0] ?? defaultArchitecture;
  if (requested === "all") {
    if (!allowAll) throw new Error("--arch=all is not supported by this command.");
    return [...WINDOWS_ARCHITECTURES];
  }
  getWindowsArchitecture(requested);
  return [requested];
}

export function getWindowsArtifactNames(version, architectureName) {
  getWindowsArchitecture(architectureName);
  if (typeof version !== "string" || version.length === 0) throw new Error("Package version is required.");
  return Object.freeze({
    installer: `HTML Slide Studio Setup ${version}-${architectureName}.exe`,
    installerBlockmap: `HTML Slide Studio Setup ${version}-${architectureName}.exe.blockmap`,
    portable: `HTML Slide Studio-${version}-${architectureName}-portable.exe`,
    zip: `HTML Slide Studio-${version}-${architectureName}-win.zip`,
    unpackedDirectory: architectureName === "x64" ? "win-unpacked" : `win-${architectureName}-unpacked`
  });
}
