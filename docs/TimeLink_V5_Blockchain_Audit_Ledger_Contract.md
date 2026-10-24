# TimeLink V5 Blockchain Audit Ledger — Implementation Contract

Status: design and integration contract, NOT deployed on-chain.

## Source of truth
The existing D1 V5 economy ledger (`v3_economy_transactions`, `v3_economy_entries`) remains authoritative for payments, TL transfers, playback and settlement. Do not mint TLC or execute transfers in the audit pipeline. A successful payment must never depend on TON availability.

## Capture and immutability
Build an append-only audit outbox in the **same D1 batch** as each `postLedgerTransaction` insert, and do not enqueue on idempotent replay. Use the transaction UUID and stable schema version. Include transaction ID, type, source, reference, posting time, canonical ordered entries (account identifiers should be pseudonymized for public proofs), asset code, integer atoms and signed amounts. Never put customer PII, provider tokens or full receipts on-chain. Backfill older transactions explicitly with source timestamps and mark them as historical.

## Hashes and batching
Canonicalize with fixed field ordering, UTF-8, version prefix, and SHA-256. Batch transaction hashes into a deterministic Merkle tree; persist root, leaf count, time range, tree algorithm version and membership proofs. Empty batches are not submitted. A sealed batch cannot be mutated. Chain individual batch roots to prior roots as an additional audit continuity check. Reject missing sequence numbers; detect and alert on gaps.

## TON anchoring
Use a dedicated audit identity/wallet, separate from TLC mint authority. Submit only batch root, version and range/sequence commitments to TON, recording pending/confirmed/failed states and chain transaction identifiers. Retry idempotently; never falsely mark confirmed from an HTTP submit response. Verify finalized chain inclusion and enable independent proof validation. Handle chain reorg/finality semantics.

## Reconciliation
Recompute hashes from ledger records, compare to outbox, batch roots and TON commitments. Provide admin dashboard with transaction counts, first/last IDs, confirmation latency, gaps, mismatch and resubmission controls. Permissioned manual corrections must be new compensating ledger entries, not edits of historic proofs.

## Release gates
1. D1 migration and same-batch outbox write tested with payment success, rollback, duplicate and concurrency cases.
2. Stable hash test vectors and Merkle proof verification.
3. TON testnet submit, retry, chain confirmation and reconciliation.
4. Security and privacy review, fee budgets and monitoring.
5. Production enablement behind administrator control with fail-safe queueing.

This document does not claim the blockchain audit functionality is live.
