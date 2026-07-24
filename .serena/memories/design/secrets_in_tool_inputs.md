# Secrets in tool inputs (design principle)

The redactor we ship in `PortainerClient.request<T>()` protects
**responses** from Portainer — secret env values get scrubbed before
the LLM sees them. It does NOT protect secrets the user passes IN as
tool parameters.

## The trap

Three existing tools accept a credential param:

- `portainer_set_git_auth({ password })`
- `portainer_create_git_stack({ password })`
- `portainer_convert_stack_to_git({ password })`

Anything passed to these lands in:

- The conversation transcript
- The tool-call log
- Any session persistence (Claude Desktop history, OpenChronicle,
  Serena memories, file backups…)

The Portainer UI's password field is more ephemeral than chat —
browser session, in-memory form state, gone on refresh. So for
credential **rotations**, the UI is genuinely the safer surface.

## Operational guidance

- **Use the existing credential-bearing tools sparingly.** Initial
  setup with a scoped easy-to-rotate PAT is a reasonable use case;
  ongoing rotation is not.
- **Prefer the Portainer UI for credential rotation.** Less durable
  exposure surface.
- **Do not propose new MCP tools that take secrets as input by
  default.** Specifically refused during the 2026-05-01 design pass:
  - `portainer_update_registry({ password })` (registry credential)
  - `portainer_create_git_credential({ password })` (named git
    credential store)
  - `portainer_update_git_credential({ password })`
- **Pure read/inspect/delete tools touching credential records ARE
  fine** — they don't transit secret values. If a need arises:
  - `portainer_list_registries`, `portainer_inspect_registry`,
    `portainer_delete_registry`
  - `portainer_list_git_credentials`,
    `portainer_delete_git_credential`

## When in doubt

Re-read CLAUDE.md "Conventions" → Secrets-in-tool-INPUTS section, and
STATUS.md "Design Principles" — both ship the same lesson with full
reasoning.

## Origin

Surfaced 2026-05-01 at session-end after the assistant proposed
`portainer_update_registry` as Tier 1 "close the credential
management loop" work. User correctly pushed back: *"if I'm cutting
and pasting tokens into agents like you to manage credentials aren't
we back to the previous problem?"* That's the question to remember.
