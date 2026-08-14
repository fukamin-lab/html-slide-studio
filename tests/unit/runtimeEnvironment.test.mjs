import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findForbiddenPackagedChromiumSwitch,
  resolveDevelopmentRemoteDebuggingPort,
  resolveDevelopmentRendererUrl
} from "../../src/main/runtimeEnvironment.ts";

test("packaged runtime ignores renderer URL and remote-debugging environment variables", () => {
  assert.equal(resolveDevelopmentRendererUrl("http://127.0.0.1:31220", true), null);
  assert.equal(resolveDevelopmentRendererUrl("https://attacker.example", true), null);
  assert.equal(resolveDevelopmentRemoteDebuggingPort("31220", true), null);
});

test("development renderer accepts only an exact IPv4 loopback HTTP origin", () => {
  assert.equal(resolveDevelopmentRendererUrl("http://127.0.0.1:31220/", false, "http://127.0.0.1:31220"), "http://127.0.0.1:31220");
  assert.throws(
    () => resolveDevelopmentRendererUrl("http://127.0.0.1:31221", false, "http://127.0.0.1:31220"),
    /allocated development endpoint/
  );
  for (const invalid of [
    "http://localhost:31220",
    "http://127.0.0.1:31220/path",
    "http://127.0.0.1:31220/?query=1",
    "https://127.0.0.1:31220",
    "http://192.168.1.10:31220",
    "not-a-url"
  ]) {
    assert.throws(() => resolveDevelopmentRendererUrl(invalid, false), /loopback HTTP origin/);
  }
});

test("development remote-debugging port is bounded and numeric", () => {
  assert.equal(resolveDevelopmentRemoteDebuggingPort("31220", false), "31220");
  for (const invalid of ["80", "0", "65536", "31220x"]) {
    assert.throws(() => resolveDevelopmentRemoteDebuggingPort(invalid, false), /development TCP port/);
  }
});

test("packaged runtime rejects Chromium switches that weaken isolation or expose debugging", () => {
  for (const argument of [
    "--remote-debugging-port=9222",
    "--remote-debugging-pipe",
    "--inspect=9229",
    "--inspect-brk",
    "--no-sandbox",
    "-no-sandbox",
    "/no-sandbox",
    "--disable-web-security",
    "/disable-web-security",
    "--disable-features=SitePerProcess",
    "--js-flags=--allow-natives-syntax"
  ]) {
    assert.equal(findForbiddenPackagedChromiumSwitch(["HTML Slide Studio.exe", argument], true), argument);
  }
  assert.equal(findForbiddenPackagedChromiumSwitch(["HTML Slide Studio.exe", "--user-data-dir=C:\\temp\\profile"], true), null);
  assert.equal(findForbiddenPackagedChromiumSwitch(["electron.exe", "--remote-debugging-port=9222"], false), null);
  assert.equal(
    findForbiddenPackagedChromiumSwitch(["HTML Slide Studio.exe", "--", "--remote-debugging-port=9222"], true),
    null
  );
});
