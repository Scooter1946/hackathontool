import { describe, expect, it } from "vitest";
import {
  CONTAINER_DEFAULTS,
  type ContainerOptions,
  parseExpose,
  renderContainerCreateArgs,
  renderContainerEntrypoint,
  renderContainerfile,
  renderEnterScript,
  renderExposeMounts,
  renderHostBridge,
  renderSudoersEntry,
} from "./container-artifacts.js";

const co = (over: Partial<ContainerOptions> = {}): ContainerOptions => ({
  image: CONTAINER_DEFAULTS.image,
  containerName: CONTAINER_DEFAULTS.containerName,
  port: 4517,
  group: "teamctx",
  teamDir: "/team",
  homesDir: CONTAINER_DEFAULTS.homesDir,
  exposes: [],
  users: ["alice", "bob"],
  enterPath: CONTAINER_DEFAULTS.enterPath,
  bridgePath: CONTAINER_DEFAULTS.bridgePath,
  containerShellPath: CONTAINER_DEFAULTS.containerShellPath,
  ...over,
});

describe("parseExpose", () => {
  it("defaults to a read-write mount at the same path", () => {
    expect(parseExpose("/data")).toEqual({ host: "/data", container: "/data", readOnly: false });
  });
  it("honors a :ro suffix", () => {
    expect(parseExpose("/data:ro")).toEqual({ host: "/data", container: "/data", readOnly: true });
  });
  it("remaps host:container and keeps :ro", () => {
    expect(parseExpose("/srv/data:/data:ro")).toEqual({
      host: "/srv/data",
      container: "/data",
      readOnly: true,
    });
  });
  it("rejects an empty spec", () => {
    expect(() => parseExpose(":ro")).toThrow(/invalid --expose/);
  });
});

describe("renderExposeMounts", () => {
  it("renders -v args with the right ro/rw flag", () => {
    expect(
      renderExposeMounts([
        { host: "/a", container: "/a", readOnly: false },
        { host: "/b", container: "/mnt/b", readOnly: true },
      ]),
    ).toEqual(["-v", "/a:/a", "-v", "/b:/mnt/b:ro"]);
  });
});

describe("renderContainerfile", () => {
  it("installs Claude Code from Anthropic's official signed apt repo (unmodified)", () => {
    const df = renderContainerfile(co());
    expect(df).toContain("downloads.claude.ai/claude-code/apt/stable");
    expect(df).toContain("/etc/apt/keyrings/claude-code.asc");
    expect(df).toContain("apt-get install -y --no-install-recommends claude-code");
  });
  it("builds the server (native better-sqlite3) in a builder stage, not copied from the host", () => {
    const df = renderContainerfile(co());
    expect(df).toContain("AS builder");
    expect(df).toContain("python3 make g++");
    expect(df).toContain("npm run build --workspace @teamctx/server");
    expect(df).toContain("COPY --from=builder /src/packages/server/dist");
  });
  it("installs git and the GitHub CLI for per-user auth", () => {
    const df = renderContainerfile(co());
    expect(df).toContain("git");
    expect(df).toContain("cli.github.com/packages");
  });
  it("sets the data dir under the mounted team folder", () => {
    expect(renderContainerfile(co({ teamDir: "/team" }))).toContain(
      "TEAMCTX_DATA_DIR=/team/.teamctx-data",
    );
  });
});

describe("renderContainerEntrypoint", () => {
  it("provisions each teammate with a private 0700 home, then runs the server on loopback", () => {
    const ep = renderContainerEntrypoint(co());
    expect(ep).toContain("useradd -m -s /bin/bash");
    expect(ep).toContain('chmod 700 "/home/${U}"');
    expect(ep).toContain("exec node /opt/teamctx/server/dist/main.js");
  });
});

describe("renderContainerCreateArgs", () => {
  const args = renderContainerCreateArgs(co()).join(" ");

  it("mounts /team and the private homes dir", () => {
    expect(args).toContain("-v /team:/team");
    expect(args).toContain("-v /var/lib/teamctx/homes:/home");
  });
  it("passes the user list and data dir to the box", () => {
    expect(args).toContain("TEAMCTX_USERS=alice,bob");
    expect(args).toContain("TEAMCTX_DATA_DIR=/team/.teamctx-data");
  });
  it("never mounts the Docker socket (that would be host root)", () => {
    expect(args).not.toContain("docker.sock");
  });
  it("hardens the container and does not publish a public port", () => {
    expect(args).toContain("--cap-drop ALL");
    expect(args).toContain("--security-opt no-new-privileges");
    expect(args).not.toContain("-p ");
  });
  it("includes extra exposes as bind mounts", () => {
    const withExpose = renderContainerCreateArgs(
      co({ exposes: [{ host: "/srv/data", container: "/data", readOnly: true }] }),
    ).join(" ");
    expect(withExpose).toContain("-v /srv/data:/data:ro");
  });
});

describe("host bridge + enter script (privilege model)", () => {
  it("the ForceCommand bridge only hands off to the pinned enter script via sudo", () => {
    const bridge = renderHostBridge(co());
    expect(bridge).toContain(`exec sudo -n ${CONTAINER_DEFAULTS.enterPath}`);
    // The guest's own account is never given docker access.
    expect(bridge).not.toContain("docker");
  });

  it("the enter script derives identity from SUDO_USER, not arguments", () => {
    const enter = renderEnterScript(co());
    expect(enter).toContain('U="${SUDO_USER:-}"');
    // Identity is validated against the provisioned user list.
    expect(enter).toContain("is not a teamctx user");
    // It execs into the box as that user and runs the in-container shell.
    expect(enter).toContain(`docker exec -it -u "${"${U}"}" ${CONTAINER_DEFAULTS.containerName}`);
  });

  it("the sudoers rule is scoped to exactly the enter script, NOPASSWD", () => {
    expect(renderSudoersEntry(co())).toBe(
      `%teamctx ALL=(root) NOPASSWD: ${CONTAINER_DEFAULTS.enterPath}\n`,
    );
  });
});
