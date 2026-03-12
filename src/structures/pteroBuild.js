const api = require("./Ptero");

function resolveAllocationId(attrs) {
  const direct = attrs?.allocation;
  if (Number.isFinite(direct)) return direct;
  if (direct && Number.isFinite(direct?.id)) return direct.id;

  const allocations = attrs?.allocations;
  if (Number.isFinite(allocations?.default)) return allocations.default;
  if (allocations?.default && Number.isFinite(allocations.default?.id)) return allocations.default.id;

  const list = Array.isArray(allocations) ? allocations : allocations?.data;
  if (Array.isArray(list) && list.length) {
    const first = list[0];
    if (Number.isFinite(first?.id)) return first.id;
    if (Number.isFinite(first?.attributes?.id)) return first.attributes.id;
  }

  return null;
}

async function getServerAttributes(serverId) {
  const res = await api.get(`/servers/${serverId}`);
  return res.data?.attributes || {};
}

function buildBuildPayload(attrs, nextLimits = {}) {
  const allocation = resolveAllocationId(attrs);
  if (!allocation) {
    const err = new Error("Unable to resolve server allocation for build update.");
    err.code = "MISSING_ALLOCATION";
    throw err;
  }

  const current = attrs.limits || {};
  const featureLimits = attrs.feature_limits || {};

  return {
    allocation,
    memory: Number(nextLimits.memory ?? current.memory ?? 0),
    swap: Number(nextLimits.swap ?? current.swap ?? 0),
    disk: Number(nextLimits.disk ?? current.disk ?? 0),
    io: Number(nextLimits.io ?? current.io ?? 0),
    cpu: Number(nextLimits.cpu ?? current.cpu ?? 0),
    oom_disabled:
      typeof nextLimits.oom_disabled === "boolean"
        ? nextLimits.oom_disabled
        : Boolean(current.oom_disabled),
    feature_limits: {
      databases: Number(featureLimits.databases ?? 0),
      backups: Number(featureLimits.backups ?? 0),
      allocations: Number(featureLimits.allocations ?? 0),
    },
  };
}

async function updateServerBuild(serverId, nextLimits) {
  const attrs = await getServerAttributes(serverId);
  const payload = buildBuildPayload(attrs, nextLimits);
  await api.patch(`/servers/${serverId}/build`, payload);
  return attrs;
}

module.exports = {
  getServerAttributes,
  updateServerBuild,
};
