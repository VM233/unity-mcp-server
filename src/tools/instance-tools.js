// AnkleBreaker Unity MCP — Tool definitions for Multi-Instance Management
// These tools let agents discover, list, and select which Unity Editor instance to work with.

import {
  discoverInstances,
  selectInstance,
  getSelectedInstance,
  autoSelectInstance,
} from "../instance-discovery.js";

export const instanceTools = [
  {
    name: "unity_list_instances",
    description:
      "List registered Unity Editor instances, including reload status and current reachability. " +
      "Returns each instance's project name, port, Unity version, and whether it's a ParrelSync clone. " +
      "Use this to see which Unity projects are currently open before selecting one to work with.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async () => {
      const instances = await discoverInstances();
      const selected = getSelectedInstance();

      return JSON.stringify({
        instances: instances.map((inst) => ({
          port: inst.port,
          projectName: inst.projectName,
          projectPath: inst.projectPath,
          unityVersion: inst.unityVersion,
          isClone: inst.isClone,
          cloneIndex: inst.cloneIndex,
          status: inst.status || (inst.alive ? "ready" : "temporarily_unreachable"),
          queueReady: inst.queueReady !== false,
          ...(inst.busyReason ? { busyReason: inst.busyReason } : {}),
          isReloading: inst.isReloading === true,
          isReachable: inst.isReachable !== false,
          source: inst.source,
          isSelected: selected ? selected.port === inst.port : false,
        })),
        selectedPort: selected?.port || null,
      });
    },
  },

  {
    name: "unity_select_instance",
    description:
      "Select which Unity Editor instance to work with for this session. " +
      "All subsequent unity_* commands will be routed to the selected instance. " +
      "Provide a port returned by unity_list_instances. A later call may still override " +
      "the target with its own port or expectedProjectPath.",
    inputSchema: {
      type: "object",
      properties: {
        port: {
          type: "integer",
          minimum: 1,
          maximum: 65535,
          description:
            "The port number of the Unity instance to select (from unity_list_instances output).",
        },
      },
      required: ["port"],
    },
    handler: async ({ port }) => {
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return JSON.stringify(
          {
            success: false,
            errorCode: "invalid_port",
            retryable: false,
            error:
              "port must be an integer between 1 and 65535.",
          }
        );
      }

      const result = await selectInstance(port);
      return JSON.stringify(result);
    },
  },
];
