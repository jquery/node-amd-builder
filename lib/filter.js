"use strict";

var path = require( "path" );

function apply( baseUrl, filter, contents, ext, callback ) {
	if ( filter ) {
		require( path.join( baseUrl, filter ) )( contents, ext, callback );
	} else {
		callback( null, contents );
	}
}

exports.apply = apply;