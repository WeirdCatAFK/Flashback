/** True when running from source rather than a packaged build. */
function isDev() {
  return process.env.NODE_ENV === "development";
}
export { isDev };

