var app = require( 'express' ).createServer(),
	fs = require( 'fs' ),
	exec = require('child_process').exec,
	spawn = require( 'child_process' ).spawn;

var port = 3000,
	bareRepo = process.env.BARE_REPO || "../jquery-mobile",
	dstDirBase = ( process.env.OUTPUT_DIR || "../src" ) + "/jquery-mobile.";

if ( process.env.SERVER === "PRODUCTION" ) {
	port = 80;
}

app.get( '/', function( req, res  ) {
	res.send("<h1 style='text-align: center; font-size: 120px;'>ZOMG JQM-BUILDER</h1>");
});

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

app.listen( port );