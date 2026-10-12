# PenguMint validation

## Automated checks

- Production Next.js build succeeds, including TypeScript and all server routes.
- Wallet/media tests pass: randomized encrypted backups, correct-password restoration, wrong-password rejection, authenticated-ciphertext tampering rejection, address mismatch, strict format validation, safe media schemes and UTF-8/content limits.
- Local Anvil EVM tests pass on chain ID 84532: contract deployment and bytecode match; browser/Solidity commitment parity; ERC-721 ownership and escaped metadata; EOA and deployed ERC-1271 proof verification; forged/changed proofs; duplicate mint rejection; image/signature/private proof records; passport counters; creator-only parent links; immutable originals; self/duplicate witness rejection; public witness/activity counts; newest-first bounded pagination.

## Production-browser integration

Headless Chromium tested the production Next.js server against an actual local Anvil EVM, with two independent viewers and an injected EIP-6963 wallet provider.

- Create an in-site wallet with a password. Only its encrypted vault is stored locally.
- Fund that test wallet on the local EVM and submit signed, mined transactions through the application's RPC proxy.
- Publish a note, a compact image, a drawn signature, a private file proof and a linked revision.
- Confirm another viewer receives the new records without a page reload.
- Verify the public creator signature without connecting a wallet.
- Connect an external wallet, request the correct chain, review acknowledgement gas and confirm a peer witness. Another viewer sees the changed witness count.
- Follow a revision link to the original creation.
- Lock the in-site wallet, reject the wrong password and unlock with the correct password.
- Block privileged node-admin RPC methods.
- Check mobile/desktop horizontal overflow, single guide, moving native scenery, contextual help and music under a browser policy permitting autoplay.
- No JavaScript page errors were observed during the completed integration run.

A separate mobile setup run started with no configured contract: created a wallet, downloaded an encrypted backup, restored it in another context, estimated and confirmed deployment through the actual wizard, verified its exact bytecode, then minted a note. The detailed fighter was visibly captured during the confirmed-mint celebration. The File proof learning action opened the correct composer tab. With a browser policy blocking initial audio, sound began after the first permitted interaction.

The IPFS upload path was exercised with real file hashing, HMAC challenge creation, wallet signing, server validation and contract minting, using a local pinning-provider fixture. It is not a claim of a live Pinata account upload. WalletConnect QR connections are included but need an operator project ID and were not paired to a real external mobile wallet in this environment.

## Testnet and deliverable status

The official Base Sepolia RPC was contacted successfully and returned chain ID 84532. A public classroom contract was not deployed: no funded deployment wallet was supplied. The package includes the compiled artifact and a wallet-based deployment wizard. The operator must get test ETH, deploy a wall and set/share its address as described in SETUP.md.

The proposal is rendered and visually checked as a single-page Word document using the supplied seven-section template. Student identities and supervisor details remain blank for the actual group to fill in. Test harness screenshots and temporary development wallets are not included in the ZIP.
