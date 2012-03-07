# Node AMD builder

This project aims at providing a NodeJS service to build bundles out of AMD projects in a git repository. This was developed to help jQuery Mobile build the bundle builder.
Initial checkout as well as workspace creation have to be done manually.

[![endorse](http://api.coderwall.com/ghislain/endorse.png)](http://coderwall.com/ghislain)

## API v1

### /v1/{project}/{repo}

Fetch the latest version of the repo from the default remote.

### /v1/{project}/{repo}/{ref}

Force checkout the ref into the {project}/{ref}/{repo} workspace if it exists.

### /v1/dependencies/{project}/{repo}/{ref}

Traces 1st level dependencies.

URL arguments are:

 - ```baseUrl```: The baseUrl for module name to file resolution
 - ```names```: An optional comma separated list of modules to include in the dependency map. If it's not specified, the service will compute the dependency map for all the .js files in the ```baseUrl``` directory.

### /v1/bundle/{project}/{repo}/{ref}/{name}?

```name``` is the name of the file generated it defaults to ```repo```.js

Builds a bundle for this repository's ref

URL arguments are:

 - ```baseUrl```: The baseUrl for module name to file resolution
 - ```include```: A comma separated list of modules to include in the bundle
 - ```exclude```: A comma separated list of modules to exclude from the bundle
 - ```optimize```: "none" or "uglify"

## License

Copyright (c) 2012, Ghislain Seguin (MIT License)