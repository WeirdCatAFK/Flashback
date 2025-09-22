/* A bridge for the operations of the flashback canonical data system */

import { get as config } from './config';

export default class Files {
    constructor() {
        this.config = config();
        this.dataPath = this.config.dataPath;
    }
    CreateIdentifierHash(name, creator, context, relativePathToRootFolder) { }

    createFlashbackFile(context) { 
        if (context === "file") {
            /* Create the json file for the folder */
        }
        if (context === "folder") {
            /* Create the json file for the folder */
        }
    }

}