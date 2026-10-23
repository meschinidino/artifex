# ARCA homologación runbook (test only, never production)

Proven 2026-10-23: key+CSR → WSASS cert → wsfe authorization → test
CAE in ~4h of day 1. The committed proof is `e2e/toaster.test.ts`;
the seam is `server/toaster-arca.ts` + `server/toaster-proof.ts`.

## Split of labor

- Agent does the crypto (openssl, local files, no secrets in chat/logs).
- Human does the portal (needs CUIT + clave fiscal in their own ARCA
  desktop). Nothing here can be clicked by an agent.

## Step 1 — key + CSR (agent)

```bash
mkdir -p ~/.arca-homo && chmod 700 ~/.arca-homo && cd ~/.arca-homo
openssl genrsa -out arca-homo.key 2048
openssl req -new -key arca-homo.key \
  -subj "/C=AR/O=<Full Name>/CN=<CertName>/serialNumber=CUIT <cuit>" \
  -out arca-homo.csr
chmod 600 arca-homo.key arca-homo.csr
openssl req -in arca-homo.csr -noout -subject   # eyeball it, never print the key
```

Rules: CN is letters+numbers only (ours: `ToasterHomo1`). Files live
in `~/.arca-homo/`, OUTSIDE the repo, `0600`. Never commit, never paste
the key anywhere.

## Step 2 — certificate (human, ~10 min)

ARCA desktop → app **WSASS - Autogestión Certificados Homologación**
→ **Nuevo Certificado**: symbolic DN name = the CSR's CN, paste the
FULL CSR **including the `BEGIN/END CERTIFICATE REQUEST` armor lines**,
download the cert. Save as `~/.arca-homo/arca-homo.crt`, `chmod 600`
(`pbpaste > ~/.arca-homo/arca-homo.crt` if it renders as text).

If WSASS is missing from the desktop, follow "Cómo Habilitar el
Administrador de Certificados de Pruebas" first (the one bureaucratic
trap): https://www.afipts.com/tutorial/enable_testing_certificates.html

Full walkthrough: https://www.afipts.com/tutorial/obtain-testing-certificate

## Step 3 — authorize wsfe (human, ~2 min) — THE TRAP

Same WSASS app → **Crear autorización a servicio**: DN + represented
CUIT + `wsfe - Facturacion Electronica` → create → verify under
**Autorizaciones**. Walkthrough:
https://www.afipts.com/tutorial/authorize-test-web-service.html

Without this, everything authenticates but nothing bills: WSAA login
fails `ns1:coe.notAuthorized: Computador no autorizado a acceder al
servicio`. We hit exactly this on the first live run.

## Step 4 — verify (agent, before any live call)

```bash
cd ~/.arca-homo
openssl x509 -in arca-homo.crt -noout -subject -issuer -dates
# issuer MUST be the homo test CA (ours: CN=Computadores Test, O=AFIP).
# A production issuer here means STOP, wrong environment.
M1=$(openssl x509 -in arca-homo.crt -noout -modulus | openssl sha256)
M2=$(openssl rsa -in arca-homo.key -noout -modulus 2>/dev/null | openssl sha256)
[ "$M1" = "$M2" ] && echo "MODULUS MATCH" || echo "MODULUS MISMATCH"
```

## Step 5 — live proof (agent)

```bash
ARCA_HOMO_CUIT=<cuit> ARTIFEX_E2E=1 bun test ./e2e/toaster.test.ts
```

Each run mints one REAL homo test invoice (auto-numbered). First CAE
2026-10-23: `86431019564714`, resultado A, zero obs/errors.

## Learned facts (don't re-derive)

- `@arcasdk/core` (scoped; bare `arcasdk` is not on npm) manages WSAA
  tickets internally — the live path is just status + `createNextVoucher`.
  The TA is cached across processes (2nd run: 10.7s → 0.4s).
- `INextVoucher` is NOT root-exported; derive via
  `Parameters<ElectronicBillingService["createNextVoucher"]>[0]`.
- FEDummy needs zero creds (import + round-trip provable pre-portal).
- Factura C defaults that passed homo first try: ptoVta 1, concepto 1,
  docTipo 99 + docNro 0, receptor 5, PES/1, impTotal=impNeto.
- Homo WSDLs: `https://wsaahomo.afip.gov.ar/ws/services/LoginCms?wsdl`,
  `https://wswhomo.afip.gov.ar/wsfev1/service.asmx?WSDL`.
- Proof records carry the CUIT masked (`20•••••••9`), never raw.
