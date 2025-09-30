/* Orchestrator file that makes all the necessary calls to the database and file system Ensuring that both canonical and derived data are updated
Methods are operations that are normally reflected on file explorers, specifically for the flasback data model which manages a tree-like structure
knowledge representation graph.
*/

import { get as config } from './config';
import files from './files';
import db from './database';

export default class Documents {
    constructor() {
        this.config = config();
        this.db = db;
        this.files = files;
    }

    // ---------- HELPERS ----------
    rebuild() {
        // Reads the canonical system to rebuild the database
    }

    exists() {

    }
    existsInDB() {

    }

    // ---------- File operations ----------

    createFile() {

    }
    
    createFoder(){

    }

    rename(){

    }

    move(){

    }

    delete(){

    }

    copy(){

    }

    updateFile(){

    }

    updateMetadata(){

    }



}   