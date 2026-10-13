Build the local shared and templates packages before installing charts-gen, so
their compiled `dist` files are included in the local package dependencies:

```sh
yarn --cwd ../../cubejs-backend-shared build
yarn --cwd ../../cubejs-templates build
yarn install --frozen-lockfile
```

Creating a symlink for chart renderers generation

mkdir [PATH_TO_PROJECT]/cube.js/packages/cubejs-playground/charts-gen/node_modules/.tmp
ln -s [PATH_TO_PROJECT]/cubejs-playground-templates [PATH_TO_PROJECT]/cube.js/packages/cubejs-playground/charts-gen/node_modules/.tmp/cubejs-playground-templates
