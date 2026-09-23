export type BranchPresence = "exists" | "missing" | "repository_inaccessible";

function isNotFound(error: unknown) {
  return error instanceof Error && "status" in error && error.status === 404;
}

/**
 * GitHub answers 404 both for a missing branch and for a repository the installation can no
 * longer see, so a branch 404 only means "missing" once the repository itself resolves.
 */
export async function resolveBranchPresence(
  getBranch: () => Promise<unknown>,
  getRepository: () => Promise<unknown>
): Promise<BranchPresence> {
  try {
    await getBranch();
    return "exists";
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  try {
    await getRepository();
    return "missing";
  } catch (error) {
    if (isNotFound(error)) return "repository_inaccessible";
    throw error;
  }
}
