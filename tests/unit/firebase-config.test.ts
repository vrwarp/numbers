import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { firebaseWebConfig } from "@/lib/firebase-admin";
import { firebaseAuthUpstreamHost } from "@/lib/config";

const VARS = [
  "FIREBASE_API_KEY",
  "FIREBASE_AUTH_DOMAIN",
  "FIREBASE_PROJECT_ID",
  "FIREBASE_APP_ID",
  "FIREBASE_AUTH_PROXY",
  "FIREBASE_AUTH_UPSTREAM_HOST",
  "PUBLIC_BASE_URL",
];

function clear() {
  for (const v of VARS) delete process.env[v];
}

beforeEach(() => {
  clear();
  process.env.FIREBASE_API_KEY = "key";
  process.env.FIREBASE_AUTH_DOMAIN = "proj.firebaseapp.com";
  process.env.FIREBASE_PROJECT_ID = "proj";
});

afterEach(clear);

describe("firebaseWebConfig", () => {
  it("returns null when a required var is missing", () => {
    delete process.env.FIREBASE_PROJECT_ID;
    expect(firebaseWebConfig()).toBeNull();
  });

  it("uses the Firebase authDomain by default", () => {
    expect(firebaseWebConfig()?.authDomain).toBe("proj.firebaseapp.com");
  });

  it("strips a pasted scheme (and path) from FIREBASE_AUTH_DOMAIN", () => {
    process.env.FIREBASE_AUTH_DOMAIN = "https://proj.firebaseapp.com/";
    expect(firebaseWebConfig()?.authDomain).toBe("proj.firebaseapp.com");
    process.env.FIREBASE_AUTH_DOMAIN = "http://proj.firebaseapp.com/__/auth";
    expect(firebaseWebConfig()?.authDomain).toBe("proj.firebaseapp.com");
  });

  it("points authDomain at PUBLIC_BASE_URL's host when the proxy is enabled", () => {
    process.env.FIREBASE_AUTH_PROXY = "1";
    process.env.PUBLIC_BASE_URL = "https://numbers.example.org/";
    expect(firebaseWebConfig()?.authDomain).toBe("numbers.example.org");
  });

  it("keeps the port when PUBLIC_BASE_URL includes one", () => {
    process.env.FIREBASE_AUTH_PROXY = "1";
    process.env.PUBLIC_BASE_URL = "https://numbers.example.org:8443";
    expect(firebaseWebConfig()?.authDomain).toBe("numbers.example.org:8443");
  });

  it("falls back to the Firebase authDomain when the proxy is on but PUBLIC_BASE_URL is unset", () => {
    process.env.FIREBASE_AUTH_PROXY = "1";
    expect(firebaseWebConfig()?.authDomain).toBe("proj.firebaseapp.com");
  });

  it("does not proxy when PUBLIC_BASE_URL is set but the flag is off", () => {
    process.env.PUBLIC_BASE_URL = "https://numbers.example.org";
    expect(firebaseWebConfig()?.authDomain).toBe("proj.firebaseapp.com");
  });

  it("does not require FIREBASE_AUTH_DOMAIN in proxy mode (authDomain from PUBLIC_BASE_URL)", () => {
    delete process.env.FIREBASE_AUTH_DOMAIN;
    process.env.FIREBASE_AUTH_PROXY = "1";
    process.env.PUBLIC_BASE_URL = "https://numbers.example.org";
    expect(firebaseWebConfig()?.authDomain).toBe("numbers.example.org");
  });
});

describe("firebaseAuthUpstreamHost", () => {
  it("derives from the project id, not FIREBASE_AUTH_DOMAIN", () => {
    // The operator's own domain in FIREBASE_AUTH_DOMAIN must NOT become the
    // upstream (that self-loops); the upstream is always the firebaseapp.com host.
    process.env.FIREBASE_AUTH_DOMAIN = "numbers.home.example.com";
    expect(firebaseAuthUpstreamHost()).toBe("proj.firebaseapp.com");
  });

  it("honours an explicit FIREBASE_AUTH_UPSTREAM_HOST override", () => {
    process.env.FIREBASE_AUTH_UPSTREAM_HOST = "https://proj.web.app/";
    expect(firebaseAuthUpstreamHost()).toBe("proj.web.app");
  });

  it("is undefined without a project id", () => {
    delete process.env.FIREBASE_PROJECT_ID;
    expect(firebaseAuthUpstreamHost()).toBeUndefined();
  });
});
