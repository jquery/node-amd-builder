/*
 Copyright (c) 2010 Tim Caswell <tim@creationix.com>

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to deal
 in the Software without restriction, including without limitation the rights
 to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 copies of the Software, and to permit persons to whom the Software is
 furnished to do so, subject to the following conditions:

 The above copyright notice and this permission notice shall be included in all
 copies or substantial portions of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 SOFTWARE.
 */



var ChildProcess = require( 'child_process' ),
    path = require( 'path' ),
    tools = require( './tools' ),
    fs = require( 'fs' );

var gitCommands, gitDir, workTree;

var gitENOENT = /fatal: (Path '([^']+)' does not exist in '([0-9a-f]{40})'|ambiguous argument '([^']+)': unknown revision or path not in the working tree.)/;

// Set up the git configs for the subprocess
var Git = module.exports = function ( repo, workspace ) {
    if ( !workspace ) { workspace = repo }
    // Check the directory exists first.
    try {
        fs.statSync( repo );
    } catch ( e ) {
        throw new Error( "Bad repo path: " + repo );
    }
    try {
        // Check is this is a working repo
        gitDir = path.join( repo, ".git" );
        fs.statSync( gitDir );
        workTree = workspace;
        gitCommands = ["--git-dir=" + gitDir, "--work-tree=" + workTree];
    } catch ( e ) {
        gitDir = repo;
        gitCommands = ["--git-dir=" + gitDir];
    }
};

// Internal helper to talk to the git subprocess
function gitExec( commands, encoding, callback ) {
    if ( typeof encoding === 'function' ) {
        callback = encoding;
        encoding = 'utf8';
    }
    encoding = encoding || 'utf8';
    commands = gitCommands.concat( commands );
    var child = ChildProcess.spawn( "git", commands, {
            encoding: encoding,
            timeout:0,
            cwd: gitDir,
            env:null
        });
    var stdout = [], stderr = [];
    child.stdout.on( 'data', function ( text ) {
        stdout[stdout.length] = text;
    });
    child.stderr.on( 'data', function ( text ) {
        stderr[stderr.length] = text;
    });
    child.on( 'exit', function ( code ) {
        if ( code > 0 ) {
            var err = new Error( "git " + commands.join( " " ) + "\n" + tools.join( stderr, 'utf8' ) );
            if ( gitENOENT.test( err.message ) ) {
                err.errno = process.ENOENT;
            }
            callback( err );
            return;
        }
        callback( null, tools.join( stdout, encoding ) );
    });
    child.stdin.end();
}

Git.exec = gitExec;