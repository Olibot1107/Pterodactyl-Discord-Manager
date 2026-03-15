const axios = require("axios");
const { customDomains } = require("../../settings");

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.replace(/\/+$/, "");
}

function normalizeBasePath(value) {
  const raw = String(value || "").trim();
  if (!raw) return "/__proxy-admin";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function getProxyAdminConfig() {
  const baseUrl = normalizeBaseUrl(customDomains?.adminUrl || customDomains?.url);
  const basePath = normalizeBasePath(customDomains?.basePath);
  const masterToken = String(customDomains?.masterToken || "").trim();
  const adminBaseUrl = baseUrl ? `${baseUrl}${basePath}` : "";
  return { adminBaseUrl, masterToken };
}

function createProxyAdminClient() {
  const { adminBaseUrl, masterToken } = getProxyAdminConfig();
  if (!adminBaseUrl || !masterToken) return null;

  return axios.create({
    baseURL: adminBaseUrl,
    headers: {
      Authorization: `Bearer ${masterToken}`,
      "x-master-token": masterToken,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
}

module.exports = {
  createProxyAdminClient,
  getProxyAdminConfig,
};
