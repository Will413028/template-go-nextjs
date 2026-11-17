// Package archtest asserts the module boundaries (backend/AGENTS.md) on the transitive dependencies that
// go list reports, so new modules are covered without editing a rule list. depguard in .golangci.yml checks the
// direct imports of every file, including tests; this package catches what reaches a module through another package.
package archtest

import (
	"fmt"
	"strings"
)

const connectPkg = "connectrpc.com/connect"

// Package is a Go package with its transitive non-test dependencies.
type Package struct {
	ImportPath string
	Deps       []string
}

// Check returns one violation per forbidden dependency of a package under internal/modules/<m> (another module,
// net/http, internal/httpapi, the generated contract code (internal/gen) or Connect) and of a package under
// internal/platform (any module or internal/httpapi: platform is the bottom layer).
func Check(modulePath string, pkgs []Package) []string {
	var violations []string
	for _, p := range pkgs {
		layer, rule := rulesFor(modulePath, p.ImportPath)
		if rule == nil {
			continue
		}
		for _, d := range p.Deps {
			if broken := rule(d); broken != "" {
				violations = append(violations, fmt.Sprintf("%s -> %s: %s %s", p.ImportPath, d, layer, broken))
			}
		}
	}
	return violations
}

// rulesFor returns the layer label and the dependency rule for a package, or a nil rule when none applies.
func rulesFor(modulePath, importPath string) (string, func(d string) string) {
	platform := modulePath + "/internal/platform"
	if importPath == platform || strings.HasPrefix(importPath, platform+"/") {
		return "platform", func(d string) string { return platformForbidden(modulePath, d) }
	}
	if self, ok := moduleOf(modulePath+"/internal/modules/", importPath); ok {
		return "module " + self, func(d string) string { return forbidden(modulePath, self, d) }
	}
	return "", nil
}

// forbidden is the rule a dependency d of module self breaks, "" when it breaks none.
func forbidden(modulePath, self, d string) string {
	under := func(pkg string) bool { return d == pkg || strings.HasPrefix(d, pkg+"/") }
	if other, ok := moduleOf(modulePath+"/internal/modules/", d); ok && other != self {
		return "must not depend on module " + other
	}
	switch {
	case d == "net/http":
		return "must not depend on net/http; handlers live in internal/httpapi"
	case under(modulePath + "/internal/httpapi"):
		return "must not depend on internal/httpapi"
	case under(modulePath + "/internal/gen"):
		return "must not depend on internal/gen; handlers in internal/httpapi convert generated messages"
	case under(connectPkg):
		return "must not depend on Connect; handlers live in internal/httpapi"
	}
	return ""
}

// platformForbidden is the rule a dependency d of a platform package breaks, "" when it breaks none.
func platformForbidden(modulePath, d string) string {
	under := func(pkg string) bool { return d == pkg || strings.HasPrefix(d, pkg+"/") }
	switch {
	case under(modulePath + "/internal/modules"):
		return "must not depend on modules"
	case under(modulePath + "/internal/httpapi"):
		return "must not depend on internal/httpapi"
	}
	return ""
}

// moduleOf returns the module name of an import path under internal/modules/.
func moduleOf(modules, importPath string) (string, bool) {
	rest, ok := strings.CutPrefix(importPath, modules)
	if !ok || rest == "" {
		return "", false
	}
	name, _, _ := strings.Cut(rest, "/")
	return name, true
}
