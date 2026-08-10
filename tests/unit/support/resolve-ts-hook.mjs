// Node module customization hook used only by tests/unit test files.
//
// Why this exists: several src/renderer/editor/*.ts modules import sibling
// modules with extensionless specifiers (e.g. `import { parseTranslate } from
// "./transform"`), which is valid under the project's tsconfig
// (moduleResolution: "bundler", resolved by electron-vite/esbuild at build
// time) but is NOT valid under plain Node ESM resolution, which requires an
// explicit file extension on relative specifiers. Running
// `node --experimental-strip-types` alone cannot load those modules; it
// throws ERR_MODULE_NOT_FOUND for the extensionless specifier.
//
// This hook is registered (via node:module `register()`) from within a test
// file, before that file dynamically imports the module under test. It does
// not change source under src/, does not add an npm dependency, and does not
// change the mandated run command `node --experimental-strip-types --test
// tests/unit`. It only teaches Node to also try `<specifier>.ts` when a
// relative specifier without an extension fails to resolve.
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && !/\.[a-zA-Z0-9]+$/.test(specifier)) {
    try {
      return await nextResolve(`${specifier}.ts`, context);
    } catch {
      // fall through to default resolution/error below
    }
  }

  return nextResolve(specifier, context);
}
