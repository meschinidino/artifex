/**
 * Toaster gate proof (T2): WSAA login + WSFE send for one monotributo
 * factura C against homologación, recorded as a frozen proof record.
 * Status 2026-10-23 (prep): harness coded + stub-verified; the live
 * run awaits Dino's homo cert+key. The SDK manages WSAA tickets
 * internally, so the live path is status + one createNextVoucher call.
 *
 * The ToasterProof key set is FROZEN at gate (schema "toaster-gate-1"):
 * panel (T3), label (T6) and replay (T8) read this shape. Bump the
 * schema id only with a deliberate migration, never by drift.
 */
import type { ElectronicBillingService } from "@arcasdk/core";
import type { ToasterArca, ToasterCreds } from "./toaster-arca.ts";
import { createLiveArca } from "./toaster-arca.ts";

/**
 * SDK voucher input, derived from the service method (the SDK's own
 * INextVoucher is not root-exported). Tracks SDK upgrades automatically;
 * drift breaks loudly at the createNextVoucher call below.
 */
export type SdkNextVoucher = Parameters<
  ElectronicBillingService["createNextVoucher"]
>[0];

/** Proof schema id (frozen; see header). */
export const TOASTER_PROOF_SCHEMA = "toaster-gate-1" as const;

/** Homologación only. No other env value is representable. */
export type ToasterEnv = "homologacion";

/** WSFE CbteTipo for factura C (monotributo). */
export const FACTURA_C = 11;

/**
 * Minimal monotributo invoice input. Defaults target the standard
 * homo test invoice (consumidor final, pesos, productos);
 * CONFIRM live at gate — defaults are coded, not yet proven.
 */
export type ToasterInvoice = {
  ptoVta: number;
  impTotal: number;
  /** Default 99 (sin identificar / consumidor final). */
  docTipo?: number;
  /** Default 0. */
  docNro?: number;
  /** Default 5 (consumidor final). */
  ivaReceptorId?: number;
  /** Default 1 (productos). 2/3 need the service-date trio. */
  concepto?: number;
  fchServDesde?: string;
  fchServHasta?: string;
  fchVtoPago?: string;
};

export type ToasterProofNote = { code?: number; msg?: string };

export type ToasterProof = {
  schema: typeof TOASTER_PROOF_SCHEMA;
  env: ToasterEnv;
  /** True when no ARCA call was made (panel/replay must label it). */
  stub: boolean;
  ranAt: string;
  /** Never the raw CUIT (prep-local mask; T4's extension subsumes it). */
  cuitMasked: string;
  voucher: {
    ptoVta: number;
    cbteTipo: number;
    cbteDesde: number;
    cbteHasta: number;
    impTotal: number;
    monId: string;
  };
  cae: string;
  caeFchVto: string;
  /** "A" aprobado / "R" rechazado / "P" parcial ("" when absent). */
  resultado: string;
  reproceso: string;
  obs: ToasterProofNote[];
  errors: ToasterProofNote[];
  latencyMs: { status: number; voucher: number };
};

/** First-2 + last-1 CUIT mask; malformed input masks fully. */
export function maskCuit(cuit: number): string {
  const s = String(cuit);
  if (!/^\d{11}$/.test(s)) return "[masked]";
  return `${s.slice(0, 2)}•••••••${s.slice(10)}`;
}

function todayYmd(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** Pure invoice → SDK voucher mapping (no network; unit-tested). */
export function buildTestVoucher(inv: ToasterInvoice): SdkNextVoucher {
  return {
    CantReg: 1,
    PtoVta: inv.ptoVta,
    CbteTipo: FACTURA_C,
    Concepto: inv.concepto ?? 1,
    DocTipo: inv.docTipo ?? 99,
    DocNro: inv.docNro ?? 0,
    CbteFch: todayYmd(),
    ImpTotal: inv.impTotal,
    ImpTotConc: 0,
    ImpNeto: inv.impTotal,
    ImpOpEx: 0,
    ImpIVA: 0,
    ImpTrib: 0,
    FchServDesde: inv.fchServDesde,
    FchServHasta: inv.fchServHasta,
    FchVtoPago: inv.fchVtoPago,
    MonId: "PES",
    MonCotiz: 1,
    CondicionIVAReceptorId: inv.ivaReceptorId ?? 5,
  };
}

function stubProof(cuit: number, inv: ToasterInvoice): ToasterProof {
  return {
    schema: TOASTER_PROOF_SCHEMA,
    env: "homologacion",
    stub: true,
    ranAt: new Date().toISOString(),
    cuitMasked: maskCuit(cuit),
    voucher: {
      ptoVta: inv.ptoVta,
      cbteTipo: FACTURA_C,
      cbteDesde: 1,
      cbteHasta: 1,
      impTotal: inv.impTotal,
      monId: "PES",
    },
    cae: "00000000000000",
    caeFchVto: todayYmd(),
    resultado: "A",
    reproceso: "N",
    obs: [],
    errors: [],
    latencyMs: { status: 0, voucher: 0 },
  };
}

/**
 * Run the gate proof on either transport. Stub in → stub proof out
 * (honestly flagged). Live without a client fails closed.
 */
export async function runGateProof(
  arca: ToasterArca,
  cuit: number,
  inv: ToasterInvoice,
): Promise<ToasterProof> {
  if (arca.kind === "stub") return stubProof(cuit, inv);
  const client = arca.client;
  if (!client) throw new Error("toaster-proof: live proof needs a client");
  const voucher = buildTestVoucher(inv);
  const base = {
    schema: TOASTER_PROOF_SCHEMA,
    env: "homologacion" as const,
    stub: false,
    ranAt: new Date().toISOString(),
    cuitMasked: maskCuit(cuit),
    voucher: {
      ptoVta: inv.ptoVta,
      cbteTipo: FACTURA_C,
      cbteDesde: 0,
      cbteHasta: 0,
      impTotal: inv.impTotal,
      monId: "PES",
    },
  };
  const started = Date.now();
  try {
    const t0 = Date.now();
    await client.electronicBillingService.getServerStatus();
    const statusMs = Date.now() - t0;
    const t1 = Date.now();
    const res = await client.electronicBillingService.createNextVoucher(voucher);
    const voucherMs = Date.now() - t1;
    const det = res.response.FeDetResp?.FECAEDetResponse?.[0];
    const obs = det?.Observaciones?.Obs ?? [];
    const errs = res.response.Errors?.Err ?? [];
    return {
      ...base,
      voucher: {
        ...base.voucher,
        cbteDesde: det?.CbteDesde ?? 0,
        cbteHasta: det?.CbteHasta ?? 0,
      },
      cae: res.cae,
      caeFchVto: res.caeFchVto,
      resultado: det?.Resultado ?? "",
      reproceso: res.response.FeCabResp?.Reproceso ?? "",
      obs: obs.map((o) => ({ code: o.Code, msg: o.Msg })),
      errors: errs.map((e) => ({ code: e.Code, msg: e.Msg })),
      latencyMs: { status: statusMs, voucher: voucherMs },
    };
  } catch (err) {
    // Transport/auth faults (e.g. WSAA coe.notAuthorized) become a
    // failure proof, never a thrown crash: every run records.
    return {
      ...base,
      cae: "",
      caeFchVto: "",
      resultado: "",
      reproceso: "",
      obs: [],
      errors: [{ msg: err instanceof Error ? err.message : String(err) }],
      latencyMs: { status: 0, voucher: Date.now() - started },
    };
  }
}

/** Gate entry: live transport from creds, straight into the proof. */
export async function runLiveGateProof(
  creds: ToasterCreds,
  inv: ToasterInvoice,
): Promise<ToasterProof> {
  return runGateProof(createLiveArca(creds), creds.cuit, inv);
}
