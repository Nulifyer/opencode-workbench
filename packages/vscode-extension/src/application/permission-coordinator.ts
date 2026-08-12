import {
  PERMISSION_AGGREGATE_CHARACTER_LIMIT,
  type PermissionRequest,
  permissionRequestCharacters,
} from "@opencode-workbench/shared"

export type PermissionGrant = { protocol: PermissionRequest["protocol"]; type?: string; pattern: string }

export class PermissionCoordinator {
  readonly responding = new Set<string>()
  readonly automaticallyResponding = new Set<string>()
  readonly grants = new Map<string, PermissionGrant[]>()
  generation = 0
  revision = 0

  rejectOnly(request: PermissionRequest): PermissionRequest {
    return {
      id: request.id,
      sessionID: request.sessionID,
      title: request.title,
      type: request.type,
      protocol: request.protocol,
      truncated: true,
    }
  }

  bounded(requests: PermissionRequest[]): PermissionRequest[] {
    const output: PermissionRequest[] = []
    let characters = 0
    for (const request of requests) {
      if (output.length >= 100) break
      let safe = request
      let size = permissionRequestCharacters(safe)
      if (characters + size > PERMISSION_AGGREGATE_CHARACTER_LIMIT) {
        safe = this.rejectOnly(request)
        size = permissionRequestCharacters(safe)
      }
      if (characters + size > PERMISSION_AGGREGATE_CHARACTER_LIMIT) break
      output.push(safe)
      characters += size
    }
    return output
  }

  dispose(): void {
    this.responding.clear()
    this.automaticallyResponding.clear()
    this.grants.clear()
    this.generation += 1
  }
}
