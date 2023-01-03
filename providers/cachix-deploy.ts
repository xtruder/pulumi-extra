import * as pulumi from "@pulumi/pulumi";

const baseUrl = "https://app.cachix.org/api/v1/deploy";

const defaultHeaders = {
  accept: "application/json;charset=utf-8",
  "content-type": "application/json;charset=utf-8",
};

export interface CachixDeployOptions {
  workspaceName: pulumi.Input<string>;
  agentName: pulumi.Input<string>;
  storePath: pulumi.Input<string>;
  authToken: pulumi.Input<string>;
  activationToken: pulumi.Input<string>;
}

interface DeployInputs {
  workspaceName: string;
  agentName: string;
  storePath: string;
  authToken: string;
  activationToken: string;
}

interface DeployOutputs {
  workspaceName: string;
  agentName: string;
  storePath: string;
  deploymentId: string;
  index: number;
  closureSize: number;
}

interface AgentResponse {
  lastDeployment: {
    status: "Pending" | "InProgress" | "Cancelled" | "Failed" | "Succeeded";
    id: string;
    index: number;
    closureSize: number;
  };
  name: string;
  version: string;
  id: string;
  lastSeen: string;
}

async function activateDeployment({
  agentName,
  storePath,
  workspaceName,
  authToken,
  activationToken,
}: DeployInputs): Promise<{ id: string; outs: DeployOutputs }> {
  const resp = await fetch(`${baseUrl}/activate`, {
    method: "POST",
    body: JSON.stringify({
      agents: {
        [agentName]: storePath,
      },
    }),
    headers: {
      ...defaultHeaders,
      authorization: `Bearer ${activationToken}`,
    },
  });

  if (!resp.ok) {
    throw new Error(`Error activating cachix deployment: ${resp.statusText}`);
  }

  let result: AgentResponse;
  do {
    const resp = await fetch(`${baseUrl}/agent/${workspaceName}/${agentName}`, {
      headers: {
        ...defaultHeaders,
        authorization: `Bearer ${authToken}`,
      },
    });

    if (!resp.ok) {
      throw new Error(`Error waiting for response: ${resp.statusText}`);
    }

    result = await resp.json();

    await new Promise((resolve) => setTimeout(resolve, 2000));
  } while (
    result.lastDeployment.status === "Pending" ||
    result.lastDeployment.status === "InProgress"
  );

  if (result.lastDeployment.status !== "Succeeded") {
    throw new Error(
      `Cachix deployment failed with status: ${result.lastDeployment.status}`
    );
  }

  let {
    id: agentId,
    lastDeployment: { id: deploymentId, index, closureSize },
  } = result;

  return {
    id: agentId,
    outs: {
      index,
      deploymentId,
      closureSize,
      workspaceName,
      agentName,
      storePath,
    },
  };
}

const cachixDeployProvider: pulumi.dynamic.ResourceProvider = {
  async create(input: DeployInputs) {
    return await activateDeployment(input);
  },
  async update(_id, _olds: DeployOutputs, news: DeployInputs) {
    return await activateDeployment(news);
  },
  async diff(_id: string, olds: DeployOutputs, news: DeployInputs) {
    let changes: boolean = false;
    const replaces: string[] = [];
    const stables = ["workspaceName", "agentName"];

    if (olds.workspaceName !== news.workspaceName)
      replaces.push("workspaceName");
    if (olds.agentName !== news.agentName) replaces.push("agentName");
    if (olds.storePath !== news.storePath) changes = true;
    if (replaces.length) changes = true;

    return { changes, replaces, stables };
  },
};

export class CachixDeploy extends pulumi.dynamic.Resource {
  /**
   * These are the same properties that were originally passed as inputs, but available as outputs
   * for convenience. The names of these properties must match with `CachixDeployOptions`.
   */
  public readonly workspaceName: pulumi.Output<string>;
  public readonly agentName: pulumi.Output<string>;
  public readonly storePath: pulumi.Output<string>;

  // the following properties are set by cachix API
  public index: pulumi.Output<number>;
  public closeureSize: pulumi.Output<number>;

  constructor(
    name: string,
    args: CachixDeployOptions,
    opts?: pulumi.CustomResourceOptions
  ) {
    super(
      cachixDeployProvider,
      `pulumi-extra:cachix:CachixDeploy:${name}`,
      args,
      opts
    );
  }
}
