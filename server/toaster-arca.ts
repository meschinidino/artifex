/**
 * Toaster ARCA transport (T1): homologación-only client seam over
 * @arcasdk/core, plus a stub transport for headless panel work.
 * Spike result: bun import + FEDummy round-trip green (~320ms,
 * zero creds). Live calls beyond status (WSAA login, WSFE send
 * for the test CAE) land in T2. There is no production path
 * through this module: `production: false` is a literal, not a flag.
 */
import { Arca } from "@arcasdk/core";

export type ToasterServerStatus = {
  appServer: string;
  dbServer: string;
  authServer: string;
  /** True when this status is simulated (stub, never touched ARCA). */
  stub: boolean;
};

export type ToasterCreds = {
  cuit: number;
  /** PEM certificate. Never logged; T4 owns loading + masking. */
  cert: string;
  /** PEM private key. Never logged; T4 owns loading + masking. */
  key: string;
};

export type ToasterArca = {
  kind: "live" | "stub";
  /** FEDummy round-trip (live) or canned OK (stub). */
  status(): Promise<ToasterServerStatus>;
  /** Underlying SDK client (live only; T2 drives WSAA/WSFE on it). */
  client?: Arca;
};

/** Stub transport: canned OK for headless panel/film work. */
export function createStubArca(): ToasterArca {
  return {
    kind: "stub",
    status: async () => ({
      appServer: "OK",
      dbServer: "OK",
      authServer: "OK",
      stub: true,
    }),
  };
}

/**
 * Live transport: homologación only. Fails closed without
 * cert+key (no half-authenticated client escapes).
 */
export function createLiveArca(creds: ToasterCreds): ToasterArca {
  if (!creds.cert || !creds.key) {
    throw new Error("toaster-arca: live transport needs cert+key");
  }
  const client = new Arca({
    cuit: creds.cuit,
    cert: creds.cert,
    key: creds.key,
    production: false,
  });
  return {
    kind: "live",
    client,
    status: async () => {
      const s = await client.electronicBillingService.getServerStatus();
      return {
        appServer: s.appServer,
        dbServer: s.dbServer,
        authServer: s.authServer,
        stub: false,
      };
    },
  };
}
