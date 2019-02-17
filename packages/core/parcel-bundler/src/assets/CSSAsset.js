const Asset = require('../Asset');
const md5 = require('../utils/md5');
const postcss = require('postcss');
const valueParser = require('postcss-value-parser');
const postcssTransform = require('../transforms/postcss');
const CssSyntaxError = require('postcss/lib/css-syntax-error');

const URL_RE = /url\s*\("?(?![a-z]+:)/;
const IMPORT_RE = /@import/;
const COMPOSES_RE = /composes:\s*[a-zA-Z,\s]+from\s*("|').*("|')\s*;?/;
const FROM_IMPORT_RE = /([a-zA-Z,\s]+)from\s*(?:"|')(.*)(?:"|')\s*;?/;
const PROTOCOL_RE = /^[a-z]+:/;

class CSSAsset extends Asset {
  constructor(name, options) {
    super(name, options);
    this.type = 'css';
  }

  mightHaveDependencies() {
    return (
      !/\.css$/.test(this.name) ||
      IMPORT_RE.test(this.contents) ||
      COMPOSES_RE.test(this.contents) ||
      URL_RE.test(this.contents)
    );
  }

  parse(code) {
    let root = postcss.parse(code, {from: this.name, to: this.name});
    return new CSSAst(code, root);
  }

  pretransform() {
    console.log('PRETRANSFORM');
    this.cssModules = {};
  }

  collectDependencies() {
    this.ast.root.walkAtRules('import', rule => {
      let params = valueParser(rule.params);
      let [name, ...media] = params.nodes;
      let dep;
      if (
        name.type === 'function' &&
        name.value === 'url' &&
        name.nodes.length
      ) {
        name = name.nodes[0];
      }

      dep = name.value;

      if (!dep) {
        throw new Error('Could not find import name for ' + rule);
      }

      if (PROTOCOL_RE.test(dep)) {
        return;
      }

      // If this came from an inline <style> tag, don't inline the imported file. Replace with the correct URL instead.
      // TODO: run CSSPackager on inline style tags.
      let inlineHTML =
        this.options.rendition && this.options.rendition.inlineHTML;
      if (inlineHTML) {
        name.value = this.addURLDependency(dep, {loc: rule.source.start});
        rule.params = params.toString();
      } else {
        media = valueParser.stringify(media).trim();
        this.addDependency(dep, {media, loc: rule.source.start});
        rule.remove();
      }

      this.ast.dirty = true;
    });

    this.ast.root.walkDecls(decl => {
      if (URL_RE.test(decl.value)) {
        let parsed = valueParser(decl.value);
        let dirty = false;

        parsed.walk(node => {
          if (
            node.type === 'function' &&
            node.value === 'url' &&
            node.nodes.length
          ) {
            let url = this.addURLDependency(node.nodes[0].value, {
              loc: decl.source.start
            });
            dirty = node.nodes[0].value !== url;
            node.nodes[0].value = url;
          }
        });

        if (dirty) {
          decl.value = parsed.toString();
          this.ast.dirty = true;
        }
      }

      if (decl.prop === 'composes' && FROM_IMPORT_RE.test(decl.value)) {
        let parsed = valueParser(decl.value);

        parsed.walk(node => {
          if (node.type === 'string') {
            const [, selectors, importPath] = FROM_IMPORT_RE.exec(decl.value);
            this.addURLDependency(importPath, {
              dynamic: false,
              loc: decl.source.start
            });
            this.cssModules[
              this.generateTempComposesSelector(decl.parent.selector.substr(1))
            ] = selectors
              .split(',')
              .map(s => this.generateTempComposesSelector(s));
            decl.remove();
            this.ast.dirty = true;
          }
        });
      }
    });
  }

  async transform() {
    await postcssTransform(this);
  }

  generateTempComposesSelector(selector) {
    return `${md5(this.name)}__${selector.trim()}`;
  }

  postProcess(generate) {
    return generate;
  }

  // async postProcess() {
  //   await Promise.all(
  //     Object.entries(this.composesDeps).map(
  //       async ([composesAsset, mapping]) => {
  //         const asset = this.options.parser.getAsset(
  //           composesAsset,
  //           this.options
  //         );
  //         console.log('generated', asset.contents)
  //         // await processAsset(asset);
  //         Object.keys(mapping).forEach(ownSelector => {
  //           const resolvedComposesSelectors = mapping[ownSelector].map(
  //             composesSelector => asset.cssModules[composesSelector]
  //           );
  //           this.cssModules[ownSelector] = [
  //             this.cssModules[ownSelector],
  //             ...resolvedComposesSelectors
  //           ].join(' ');
  //         });
  //       }
  //     )
  //   );
  //   return this.generate()
  // }

  getCSSAst() {
    // Converts the ast to a CSS ast if needed, so we can apply postcss transforms.
    if (!(this.ast instanceof CSSAst)) {
      this.ast = CSSAsset.prototype.parse.call(this, this.ast.render());
    }

    return this.ast.root;
  }

  generate() {
    let css = this.ast ? this.ast.render() : this.contents;

    let js = '';
    if (this.options.hmr) {
      this.addDependency('_css_loader');

      js = `
        var reloadCSS = require('_css_loader');
        module.hot.dispose(reloadCSS);
        module.hot.accept(reloadCSS);
      `;
    }

    if (Object.keys(this.cssModules) !== 0) {
      js +=
        'module.exports = ' + JSON.stringify(this.cssModules, null, 2) + ';';
    }

    return [
      {
        type: 'css',
        value: css,
        cssModules: this.cssModules
      },
      {
        type: 'js',
        value: js,
        hasDependencies: false
      }
    ];
  }

  generateErrorMessage(err) {
    // Wrap the error in a CssSyntaxError if needed so we can generate a code frame
    if (err.loc && !err.showSourceCode) {
      err = new CssSyntaxError(
        err.message,
        err.loc.line,
        err.loc.column,
        this.contents
      );
    }

    err.message = err.reason || err.message;
    err.loc = {
      line: err.line,
      column: err.column
    };

    if (err.showSourceCode) {
      err.codeFrame = err.showSourceCode();
      err.highlightedCodeFrame = err.showSourceCode(true);
    }

    return err;
  }
}

class CSSAst {
  constructor(css, root) {
    this.css = css;
    this.root = root;
    this.dirty = false;
  }

  render() {
    if (this.dirty) {
      this.css = '';
      postcss.stringify(this.root, c => (this.css += c));
    }

    return this.css;
  }
}

module.exports = CSSAsset;
