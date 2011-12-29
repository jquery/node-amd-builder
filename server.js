var app = require( 'express' ).createServer(),
	fs = require( 'fs' ),
	exec = require('child_process').exec,
	spawn = require( 'child_process' ).spawn;

var bareRepo = "~/src/jquery-mobile",
	dstDirBase = "~/src/jquery-mobile.";


var gitCommands, gitDir, workTree;
var gitENOENT = /fatal: (Path '([^']+)' does not exist in '([0-9a-f]{40})'|ambiguous argument '([^']+)': unknown revision or path not in the working tree.)/;

// Internal helper to talk to the git subprocess
function gitExec(commands, callback) {
	//commands = gitCommands.concat( commands );
	var child = spawn( "git", commands );
	console.log('Spawned child pid: ' + child.pid);
	var stdout = [], stderr = [];
	child.stdout.on( 'data', function (text) {
		stdout[stdout.length] = text;
	} );
	child.stderr.on( 'data', function (text) {
		stderr[stderr.length] = text;
	} );
	child.on( 'exit', function (code) {
		if ( code > 0 ) {
			var err = new Error( "git " + commands.join( " " ) + "\n" + stderr.join( " " ) );
			if ( gitENOENT.test( err.message ) ) {
				err.errno = -1;
			}
			callback( err );
			return;
		}
		callback( null, stdout );
	} );
	child.stdin.end();
}

app.get( '/fetch', function( req, res ) {
	exec( "git fetch",
		{
			encoding: 'utf8',
		    timeout: 0,
			cwd: bareRepo,
			env: null
		},
		function( error, stdout, stderr ) {
			console.log('stdout: ' + stdout);
			console.log('stderr: ' + stderr);
			if (error !== null) {
			    res.send( error, 500 );
			} else {
				res.send( stdout );
			}
		}
	);
});

app.get( '/:tag/checkout', function( req, res ) {
	var dstDir = dstDirBase + req.params.tag;
	fs.mkdir( dstDir, function() {
		exec( "git --work-tree=" + dstDir + " checkout -f " + req.params.tag,
			{
				encoding: 'utf8',
				timeout: 0,
				cwd: bareRepo,
				env: null
			},
			function( error, stdout, stderr ) {
				console.log('stdout: ' + stdout);
				console.log('stderr: ' + stderr);
				if (error !== null) {
					res.send( error, 500 );
				} else {
					res.send( stdout );
				}
			}
		);
	});
});

app.get( '/:tag/make', function( req, res ) {
	var include = ( req.param( "include" ) || "jquery.mobile" ).split( "," ).sort(),
		dstDir = dstDirBase + req.params.tag + "/compiled/"+include.join( "+" );

	include.push("jquery.mobile.init");

	fs.rmdir( dstDir,
		function() {
			fs.mkdir( dstDir,
				function() {
					exec( [ process.execPath,
							__dirname + '/node_modules/.bin/r.js',
							'-o baseUrl=js',
							'include='+include.join(","),
							'exclude=jquery,order',
							'out=' + dstDir + '/jquery.mobile.compiled.js',
							'pragmasOnSave.jqmBuildExclude=true',
							'optimize=none' ].join( " " ),
						{
							encoding: 'utf8',
                            timeout: 0,
							cwd: dstDirBase + req.params.tag,
							env: null
						},
						function( error, stdout, stderr ) {
							console.log('stdout: ' + stdout);
							console.log('stderr: ' + stderr);
							if (error !== null) {
								res.send( error, 500 );
							} else {
								res.send( stdout );
							}
						}
					);

		//		requirejs.optimize(
		//			{
		//				baseUrl: dstDirBase + req.params.tag + "/js",
		//				dir: dstDirBase + req.params.tag + "/compiled/"+include.join( "+" ),
		//				optimize: "none",
		//				pragmasOnSave: {
		//					jqmBuildExclude: true
		//				}
		//			},
		//			function( result ) {
		//				console.log("yay!");
		//				res.send( result );
		//			}
		//		)
				}
			)
		}
	)
});

app.listen( 3000 );