import { randomUUID } from "node:crypto"

export interface IsolatedWorktreeIdentity {
  mutationID: string
  name: string
  branch: string
}

export function createIsolatedWorktreeIdentity(
  slug: string,
  now = Date.now(),
  mutationID = randomUUID(),
): IsolatedWorktreeIdentity {
  const safeSlug = slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "session"
  const nonce = mutationID.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 12)
  if (!nonce || !Number.isSafeInteger(now) || now < 0) throw new Error("Invalid isolated worktree identity")
  const name = `${safeSlug}-${now.toString(36)}-${nonce}`
  return { mutationID, name, branch: `workbench/${name}` }
}
