import { CommandModule } from "yargs";
import { CliGlobalOptions } from "../../types";
import { defaultDir } from "../../params";
import { getGithubContext } from "../../providers/github/githubActions";
import { buildHandler } from "../build";
import { Github } from "../../providers/github/Github";
import { getInstallDnpLink } from "../../utils/getLinks";
import { parseRef } from "../../providers/github/utils";

// This action should be run on 'push' and 'pull_request' events
//
// For 'push' events ('branch'):
//   Does a build test and uploads release to Pinata tagged with branch
//   and commit. It will also locate any PRs from that branch and comment
//   the resulting hash, so it can be used by testers.
//   Another job 'unpin-on-ref-delete' should delete eventually the
//   releases generated by this action
//
// For 'push' events ('tags'):
//   Skip for now. On 'tag' another action should publish instead of just
//   building, maybe it can be done by this job, but consider alternatives
//
// For 'pull_request' events:
//   Does a build test but doesn't upload the result anywhere

const botCommentTag = "(by dappnodebot/build-action)";

export const gaBuild: CommandModule<CliGlobalOptions, CliGlobalOptions> = {
  command: "build",
  describe:
    "Build and upload test release and post a comment with install link to the triggering PR",
  builder: {},
  handler: async (args): Promise<void> => await gaBuildHandler(args)
};

/**
 * Common handler for CLI and programatic usage
 */
export async function gaBuildHandler({
  dir = defaultDir
}: CliGlobalOptions): Promise<void> {
  const { eventName, sha: commitSha, ref: refString } = getGithubContext();
  const ref = parseRef(refString);

  // Connect to Github Octokit REST API and post or edit a comment on PR
  const github = new Github(dir);

  if (
    eventName === "push" &&
    ref.type === "branch" &&
    // Do not upload to pinata for branches that are never deleted
    ref.branch !== "HEAD" &&
    ref.branch !== "master" &&
    ref.branch !== "main"
  ) {
    const { releaseMultiHash } = await buildHandler({
      provider: "pinata",
      upload_to: "ipfs",
      require_git_data: true,
      delete_old_pins: true,
      verbose: true
    });

    const body = getBuildBotComment({ commitSha, releaseMultiHash });
    console.log(`Build bot comment: \n\n${body}`);

    const prs = await github.getOpenPrsFromBranch({ branch: ref.branch });
    console.log(`PRs: ${prs.map(pr => pr.number).join(", ")}`);

    await Promise.all(
      prs.map(pr =>
        github.commentToPr({ number: pr.number, body, isTargetComment })
      )
    );
    return; // done
  }

  if (eventName === "push" || eventName === "pull_request") {
    // Consider that for 'pull_request' commitSha does not represent a known commit
    // The incoming branch is merged into the target branch and the resulting
    // new commit is tested. gitHead() will return 'HEAD' for branch and a foreign commit
    // Pinata example: 'dappnodesdk.public HEAD 2f149cf'
    // See https://github.community/t/github-sha-not-the-same-as-the-triggering-commit/18286

    // By default just do a test build and skip_save
    await buildHandler({
      provider: "dappnode",
      upload_to: "ipfs",
      skip_save: true,
      verbose: true
    });
  } else if (!eventName) {
    throw Error("Not in Github action context");
  } else {
    throw Error(`Unsupported event ${eventName}`);
  }
}

/**
 * Returns formated comment with build result info
 * Comment includes `botCommentTag` which is then used by `isTargetComment()`
 * to locate any existing comment
 */
function getBuildBotComment({
  commitSha,
  releaseMultiHash
}: {
  commitSha: string;
  releaseMultiHash: string;
}) {
  const installLink = getInstallDnpLink(releaseMultiHash);

  return `DAppNode bot has built and pinned the release to an IPFS node, for commit: ${commitSha}

This is a development version and should **only** be installed for testing purposes, [install link](${installLink})

\`\`\`
${releaseMultiHash}
\`\`\`

${botCommentTag}
`;
}

/**
 * Locates any existing comment by a persistent tag used in all build bot comments
 */
function isTargetComment(commentBody: string): boolean {
  return commentBody.includes(botCommentTag);
}
