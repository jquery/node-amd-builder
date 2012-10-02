'use strict';

var _ = require( 'underscore' ),
    async = require( 'async'),
    fs = require( 'fs' ),
    Git = require( './git'),
    mkdirp = require('mkdirp' ),
    path = require( 'path' ),
    rimraf = require( 'rimraf' );

var repoBaseDir,
    workBaseDir;

module.exports.repoDir = function setRepoDir( dir ) {
	repoBaseDir = path.normalize ( dir );
	return module.exports;
}

module.exports.stagingDir = function setWorkBaseDir( dir ) {
	workBaseDir = path.normalize ( dir );
	return module.exports;
}

function fetch( repoDir, callback ) {
    Git( repoDir );
    Git.exec( [ "fetch", "-t" ], callback );
}

function remoteUpdate( repoDir, callback ) {
    Git( repoDir );
    Git.exec( [ "remote", "update" ], callback );
}

function getLastCommitHash( repoDir, callback ) {
    Git( repoDir );
    Git.exec( [ "log", "-1", "--pretty=format:%H" ], callback );
}

function cleanup( project, callback ) {
    var compiled = project.getCompiledDirSync();

    async.series([
        function( next ) {
            rimraf( compiled, next );
        },
        function( next ) {
            fs.mkdir( compiled, next );
        }
    ], callback );
}

function _checkout( project, callback ) {
	// Workspace
	var workDir = getWorkspaceDirSync( project );

	return async.waterfall([
		function( next ) {
			project.getRepoDir( next );
		},
		function( dir, next ) {
			Git( dir, workDir );
			Git.exec( [ "checkout", "-f", project.getRef() ], next );
		}
	], callback );
}

function checkout( project, force, callback ){
    if ( typeof force === "function" ) {
        callback = force;
        force = false;
    }

    // Workspace
    var workDir  = getWorkspaceDirSync( project );

    fs.exists( workDir, function( exists ) {
        if ( exists || force ) {
            async.waterfall([
                function( next ) {
                    rimraf( path.join( workDir ), next );
                },
                function( next ) {
                    mkdirp( workDir, function( err ) {
                        if ( err && err.code != "EEXIST" ) {
                            next( err );
                        } else {
                            next( null );
                        }
                    });
                },
                function( next ) {
					_checkout( project, next );
                }
            ], callback );
        } else {
            callback( "Workspace for " + project.getRepo() + "/" + project.getRef() + " has not been created" );
        }
    });
}

function checkoutIfEmpty( project, callback ){
	// Workspace
	var workDir  = getWorkspaceDirSync( project );

	fs.exists( workDir, function( exists ) {
		if ( exists ) {
			async.waterfall([
				function( next ) {
					fs.readdir( workDir, next );
				},
				function( files, next ) {
					if ( files.length == 0 ) {
						_checkout( project, function() { next(); } );
					} else {
						next();
					}
				}
			], callback );
		} else {
			callback( "Workspace for " + project.getRepo() + "/" + project.getRef() + " has not been created" );
		}
	});
}

function getFirstExistingDir( candidates, callback ) {
    var dir = candidates.shift();
    fs.exists( dir , function( exists ) {
        if ( exists ) {
            callback( null, dir );
        } else {
            if ( candidates.length ) {
                getFirstExistingDir( candidates, callback );
            } else {
                callback( "none found" );
            }
        }
    });
}

function getProjectSpecificDirSync( baseDir, project ) {
    if ( project ) {
        baseDir = path.join( baseDir, project );
    }
    return baseDir;
}

function getRepoBaseDirSync( project ) {
    return getProjectSpecificDirSync( repoBaseDir, project.getOwner() );
}

function getWorkspaceBaseDirSync( project ) {
    return getProjectSpecificDirSync( workBaseDir, project.getOwner() );
}

function getRepoDir( project, callback ) {
    var repoDir = path.join( getRepoBaseDirSync( project ), project.getRepo() );
    getFirstExistingDir( [ repoDir, repoDir + ".git" ], callback );
}

function getWorkspaceDirSync( project ) {
    var workspaceDir;
    if ( project.getOwner() ) {
        workspaceDir = path.join( project.getWorkspaceBaseDirSync(), project.getRef(), project.getRepo() )
    } else {
        path.join(project.getRepo(), project.getRef() )
    }

    return workspaceDir;
}

function getCompiledDirSync( project ) {
    return path.join( getWorkspaceDirSync( project ), "__compiled" );
}

var Project = module.exports.Project = function ( owner, repo, ref ) {
    this.owner = owner;
    this.repo = repo;
    this.ref = ref || "master";
};

Project.prototype.getOwner = function() {
    return this.owner;
}

Project.prototype.getRepo = function() {
    return this.repo;
}

Project.prototype.getRef = function() {
    return this.ref;
}

Project.prototype.checkout = function( force, callback ) {
    return checkout( this, force, callback );
}

Project.prototype.checkoutIfEmpty = function( callback ) {
	return checkoutIfEmpty( this, callback );
}

Project.prototype.cleanup = function( callback ) {
    return cleanup( this, callback );
}

Project.prototype.getRepoDir = function( callback ) {
    return getRepoDir( this, callback );
}

Project.prototype.getCompiledDirSync = function() {
    return getCompiledDirSync( this );
}

Project.prototype.getWorkspaceBaseDirSync = function() {
    return getWorkspaceBaseDirSync( this );
}

Project.prototype.getWorkspaceDirSync = function() {
    return getWorkspaceDirSync( this );
}

Project.prototype.fetch = function( callback ) {
    async.waterfall([
        _.bind( this.getRepoDir, this ),
        fetch
    ], callback );
}

Project.prototype.remoteUpdate = function( callback ) {
    async.waterfall([
        _.bind( this.getRepoDir, this ),
        remoteUpdate
    ], callback );

}

Project.prototype.getLastCommitHash = function( callback ) {
    async.waterfall([
        _.bind( this.getRepoDir, this ),
        getLastCommitHash
    ], callback );
}

module.exports.fetch = fetch;