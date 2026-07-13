# @qwen-harness/secret-store

Secure storage for OAuth tokens, authorization codes, and client secrets (MC-07) — the same class of
material as the model key, treated with the same care. A declared I/O owner: the only package that
opens the OS keyring or a secrets file.

## Three backends, fail-safe selection

In preference order:

1. **Linux Secret Service (libsecret)** — the OS keyring. The value is passed to `secret-tool` on
   STDIN, never on argv (which `/proc` would expose).
2. **Encrypted 0600 file** — AES-256-GCM. The master key comes from a **separate** approved
   provider and is **never colocated** with the ciphertext, so compromising the file alone yields
   nothing. GCM is authenticated, so a wrong key or a tampered file fails to decrypt rather than
   returning garbage. Every write is atomic (temp + rename) and mode 0600.
3. **In-memory** — session only. It **refuses to persist** rather than writing a token to disk in
   the clear. This is what makes a headless host with no secure option *safe*: the worst case loses
   tokens on restart, never leaks them.

The store never silently downgrades to an insecure store. `selectBackend` reports which one was
chosen so `doctor` can tell the user where their tokens live.

## Verified

The libsecret round-trip runs against the real OS keyring when available. The encrypted-file tests
prove the file is 0600, that neither the secret nor the master key appears in it, that a wrong key
cannot decrypt, and that a tampered file fails closed.
