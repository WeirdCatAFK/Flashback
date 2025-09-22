/*when running in Electron, both process.versions.electron and 
process.versions.node will be defined, the code will always report
 electron first, which is correct, but it's something to be aware*/
function validateEnv() {
  if (process.versions.electron) {
    console.log("running in electron environment");
    return "electron"
  };

  if (process.versions.node) {
    console.log("running in node environment");
    return "node"
  };

  console.log("Couldn't identify the environment");
  return false;
}

export default validateEnv;
