# WeRun 脚手架 · 第 2 部分：接口契约与员工身份（Task 5–8）

> 本文件是 `00-overview.md` 的续篇。执行任何任务前先读总览里的 Global Constraints 与跨任务契约（C1–C16），本文件中出现的签名、字符串均以总览为准。

**前置状态**：Task 1–4 已按契约完成——`api/go.mod`、`platform/config|logx|money|apperr|i18n|httpx|db|migrate|dbtest` 可用；`api/internal/httpapi/router.go` 里有 Task 4 的 `NewRouter`（手写 `GET /api/healthz`、`GET /api/readyz`）及其测试；`api/cmd/werun` 下有 `main.go`、`app.go`、`serve.go`、`migrate.go`、`healthcheck.go`。

**本部分已在临时模块中实测**：oapi-codegen v2.8.0 按本文 `openapi.yaml` 生成的代码可以编译；sqlc v1.31.1 用本文 `iam.sql` 对 9 个迁移文件生成成功；permgen、权限矩阵、argon2id、限流器的代码与测试均通过。下文中的生成类型名（如 `AdminLogin200JSONResponse`、`RoleOPS`、`GetStaffSessionRow`）来自实际生成结果。

**两个实测得到、执行时必须注意的事实：**

1. **strict 中间件收到的 `operationID` 是首字母大写的名字**（`adminLogin` → `"AdminLogin"`），不是 yaml 里的原样。因此 `apigen.OperationAuths` 的键用首字母大写形式，permgen 负责转换。
2. **oapi-codegen 配置加了 `compatibility.always-prefix-enum-values: true`**，枚举常量统一带类型前缀（`apigen.RoleOPS`、`apigen.AccessWrite`），避免以后新增枚举时常量名冲突。

---

### Task 5: OpenAPI 契约、代码生成与 permgen

**Files:**
- Create: `api/openapi/openapi.yaml`
- Create: `api/openapi/oapi-codegen.yaml`
- Create: `api/internal/httpapi/cmd/permgen/main.go`
- Test: `api/internal/httpapi/cmd/permgen/main_test.go`
- Create（生成）: `api/internal/httpapi/apigen/api.gen.go`
- Create（生成）: `api/internal/httpapi/apigen/permissions.gen.go`
- Create: `api/internal/httpapi/health.go`
- Create: `api/internal/httpapi/server.go`
- Test: `api/internal/httpapi/health_test.go`
- Modify（整体替换）: `api/internal/httpapi/router.go`
- Modify: `Makefile`（新增 `gen`、`gen-api`）
- Modify: `api/go.mod`、`api/go.sum`

**Interfaces:**
- Consumes：
  - `httpx.RequestID() / AccessLog(log) / Recover(cat, log) / Locale() gin.HandlerFunc`、`httpx.WriteError(c *gin.Context, cat *i18n.Catalog, log *slog.Logger, err error)`（C5）
  - `apperr.New(status int, code string) *Error`、`(*Error).Wrap(err) *Error`、`apperr.CodeBadRequest`（C3）
  - `i18n.LoadCatalog() (*i18n.Catalog, error)`（C4）、`logx.New(level string, w io.Writer) *slog.Logger`（C2）
  - `dbtest.NewPool(t testing.TB) *pgxpool.Pool`（C6）
- Produces：
  - `apigen.StrictServerInterface`、`apigen.NewStrictHandlerWithOptions`、`apigen.RegisterHandlersWithOptions`、`apigen.GetHealthz200JSONResponse`、`apigen.GetReadyz200JSONResponse`、`apigen.GetReadyz503JSONResponse`、`apigen.Health`、`apigen.ErrorResponse`
  - `apigen.AuthKind`、`apigen.AuthNone|AuthSession|AuthPermission`、`apigen.OperationAuth{Kind, Permission, Access}`、`apigen.OperationAuths map[string]OperationAuth`（键为首字母大写的 operationId）
  - `httpapi.HealthHandlers`、`httpapi.NewHealthHandlers(pool *pgxpool.Pool) *HealthHandlers`
  - `httpapi.Server{*HealthHandlers}`、`httpapi.NewServer(d RouterDeps) *Server`
  - `httpapi.RouterDeps{Log, Catalog, Pool, Server}`、`httpapi.NewRouter(d RouterDeps) *gin.Engine`（`Server` 为 nil 时用 `NewServer(d)` 补上，Task 4 的测试不用改）
  - Makefile：`make gen`、`make gen-api`

- [ ] **Step 1: 添加 kin-openapi 依赖**

```bash
cd api && go get github.com/getkin/kin-openapi@v0.149.0
```

Expected：`go.mod` 出现 `github.com/getkin/kin-openapi v0.149.0`。（oapi-codegen v2.8.0 自身依赖 v0.142.0，MVS 会统一到 v0.149.0；已实测 `go tool oapi-codegen` 在 v0.149.0 下可以正常编译。）

- [ ] **Step 2: 写 permgen 的失败测试**

`api/internal/httpapi/cmd/permgen/main_test.go`：

```go
package main

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const validSpec = `
openapi: 3.0.3
info: {title: t, version: "1"}
paths:
  /healthz:
    get:
      operationId: getHealthz
      responses: {"200": {description: ok}}
  /admin/auth/login:
    post:
      operationId: adminLogin
      x-auth: none
      responses: {"200": {description: ok}}
  /admin/me:
    get:
      operationId: adminGetMe
      x-auth: session
      responses: {"200": {description: ok}}
  /admin/events:
    post:
      operationId: adminCreateEvent
      x-permission: event_config
      x-access: write
      responses: {"201": {description: ok}}
`

func TestBuildValidSpec(t *testing.T) {
	rules, err := build([]byte(validSpec))
	require.NoError(t, err)
	assert.Equal(t, map[string]rule{
		"GetHealthz":       {Kind: "AuthNone"},
		"AdminLogin":       {Kind: "AuthNone"},
		"AdminGetMe":       {Kind: "AuthSession"},
		"AdminCreateEvent": {Kind: "AuthPermission", Permission: "event_config", Access: "write"},
	}, rules)
}

func specWithAdminOp(extensions string) string {
	return `
openapi: 3.0.3
info: {title: t, version: "1"}
paths:
  /admin/things:
    post:
      operationId: adminDoThing
` + extensions + `
      responses: {"200": {description: ok}}
`
}

func TestBuildRejectsInvalidExtensions(t *testing.T) {
	cases := []struct {
		name       string
		spec       string
		wantSubstr string
	}{
		{"admin op without extensions", specWithAdminOp(""), "后台接口必须声明 x-auth"},
		{"permission without access", specWithAdminOp("      x-permission: event_config"), "缺少 x-access"},
		{"invalid access", specWithAdminOp("      x-permission: event_config\n      x-access: admin"), "x-access 只能是 read 或 write"},
		{"invalid x-auth", specWithAdminOp("      x-auth: maybe"), "x-auth 只能是 none 或 session"},
		{"x-auth with permission", specWithAdminOp("      x-auth: session\n      x-permission: event_config\n      x-access: read"), "不能与 x-permission"},
		{"public op with permission", `
openapi: 3.0.3
info: {title: t, version: "1"}
paths:
  /events:
    get:
      operationId: listPublicEvents
      x-permission: event_config
      x-access: read
      responses: {"200": {description: ok}}
`, "公开接口不能声明"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := build([]byte(tc.spec))
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.wantSubstr)
		})
	}
}

func TestBuildReportsOperationID(t *testing.T) {
	_, err := build([]byte(specWithAdminOp("")))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "adminDoThing")
	assert.Contains(t, err.Error(), "POST /admin/things")
}

func TestStrictName(t *testing.T) {
	assert.Equal(t, "AdminLogin", strictName("adminLogin"))
	assert.Equal(t, "GetHealthz", strictName("getHealthz"))
	assert.Equal(t, "AdminPublishEvent", strictName("admin-publish_event"))
}

func TestRenderIsDeterministicAndFormatted(t *testing.T) {
	rules, err := build([]byte(validSpec))
	require.NoError(t, err)

	first, err := render(rules)
	require.NoError(t, err)
	second, err := render(rules)
	require.NoError(t, err)
	assert.Equal(t, string(first), string(second))

	src := string(first)
	assert.True(t, strings.HasPrefix(src, "// Code generated by permgen"))
	assert.Contains(t, src, "package apigen")
	assert.Contains(t, src, `{Kind: AuthPermission, Permission: "event_config", Access: "write"}`)
	assert.Contains(t, src, `{Kind: AuthSession}`)
	assert.Less(t, strings.Index(src, `"AdminCreateEvent"`), strings.Index(src, `"GetHealthz"`))
}
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `cd api && go test ./internal/httpapi/cmd/permgen/`
Expected: FAIL，编译错误 `undefined: build`、`undefined: rule`、`undefined: render`、`undefined: strictName`。

- [ ] **Step 4: 实现 permgen**

`api/internal/httpapi/cmd/permgen/main.go`：

```go
// Command permgen 读取 openapi.yaml，生成「接口 → 鉴权规则」映射表 apigen/permissions.gen.go。
//
// 规则：
//   - 路径以 /admin/ 开头的操作必须声明 x-auth（none | session），或同时声明 x-permission 与 x-access（read | write）；
//   - 其它（公开）操作不得声明这三个扩展字段，映射为 AuthNone；
//   - 映射表的键是 strict 中间件收到的 operationID：oapi-codegen 把 operationId 转成首字母大写的驼峰（adminLogin → AdminLogin）。
package main

import (
	"bytes"
	"errors"
	"flag"
	"fmt"
	"go/format"
	"os"
	"sort"
	"strings"
	"text/template"
	"unicode"

	"github.com/getkin/kin-openapi/openapi3"
)

const adminPrefix = "/admin/"

type rule struct {
	Kind       string // Go 常量名：AuthNone / AuthSession / AuthPermission
	Permission string
	Access     string
}

func main() {
	spec := flag.String("spec", "openapi/openapi.yaml", "OpenAPI 规范文件路径")
	out := flag.String("out", "internal/httpapi/apigen/permissions.gen.go", "生成文件路径")
	flag.Parse()
	if err := run(*spec, *out); err != nil {
		fmt.Fprintln(os.Stderr, "permgen:", err)
		os.Exit(1)
	}
}

func run(specPath, outPath string) error {
	data, err := os.ReadFile(specPath)
	if err != nil {
		return err
	}
	rules, err := build(data)
	if err != nil {
		return err
	}
	src, err := render(rules)
	if err != nil {
		return err
	}
	return os.WriteFile(outPath, src, 0o644)
}

func build(data []byte) (map[string]rule, error) {
	doc, err := openapi3.NewLoader().LoadFromData(data)
	if err != nil {
		return nil, fmt.Errorf("解析 OpenAPI 失败: %w", err)
	}
	rules := map[string]rule{}
	var problems []string
	for path, item := range doc.Paths.Map() {
		for method, op := range item.Operations() {
			where := method + " " + path
			if op.OperationID == "" {
				problems = append(problems, where+": 缺少 operationId")
				continue
			}
			name := strictName(op.OperationID)
			if _, dup := rules[name]; dup {
				problems = append(problems, fmt.Sprintf("%s (%s): operationId 重复", where, op.OperationID))
				continue
			}
			r, err := ruleFor(path, op.Extensions)
			if err != nil {
				problems = append(problems, fmt.Sprintf("%s (%s): %v", where, op.OperationID, err))
				continue
			}
			rules[name] = r
		}
	}
	if len(problems) > 0 {
		sort.Strings(problems)
		return nil, errors.New(strings.Join(problems, "\n"))
	}
	return rules, nil
}

func ruleFor(path string, ext map[string]any) (rule, error) {
	auth, hasAuth, errAuth := stringExt(ext, "x-auth")
	perm, hasPerm, errPerm := stringExt(ext, "x-permission")
	access, hasAccess, errAccess := stringExt(ext, "x-access")
	if err := errors.Join(errAuth, errPerm, errAccess); err != nil {
		return rule{}, err
	}

	if !strings.HasPrefix(path, adminPrefix) {
		if hasAuth || hasPerm || hasAccess {
			return rule{}, errors.New("公开接口不能声明 x-auth / x-permission / x-access")
		}
		return rule{Kind: "AuthNone"}, nil
	}

	switch {
	case hasAuth && (hasPerm || hasAccess):
		return rule{}, errors.New("x-auth 不能与 x-permission / x-access 同时声明")
	case hasAuth:
		switch auth {
		case "none":
			return rule{Kind: "AuthNone"}, nil
		case "session":
			return rule{Kind: "AuthSession"}, nil
		default:
			return rule{}, fmt.Errorf("x-auth 只能是 none 或 session，实际为 %q", auth)
		}
	case hasPerm:
		if perm == "" {
			return rule{}, errors.New("x-permission 不能为空")
		}
		if !hasAccess {
			return rule{}, errors.New("声明了 x-permission 但缺少 x-access")
		}
		if access != "read" && access != "write" {
			return rule{}, fmt.Errorf("x-access 只能是 read 或 write，实际为 %q", access)
		}
		return rule{Kind: "AuthPermission", Permission: perm, Access: access}, nil
	default:
		return rule{}, errors.New("后台接口必须声明 x-auth，或同时声明 x-permission 与 x-access")
	}
}

func stringExt(ext map[string]any, key string) (string, bool, error) {
	v, ok := ext[key]
	if !ok {
		return "", false, nil
	}
	s, isString := v.(string)
	if !isString {
		return "", true, fmt.Errorf("%s 必须是字符串", key)
	}
	return s, true, nil
}

// strictName 与 oapi-codegen 的命名一致：按非字母数字切分，每段首字母大写后拼接。
func strictName(operationID string) string {
	parts := strings.FieldsFunc(operationID, func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
	var b strings.Builder
	for _, p := range parts {
		runes := []rune(p)
		runes[0] = unicode.ToUpper(runes[0])
		b.WriteString(string(runes))
	}
	return b.String()
}

type entry struct {
	Name string
	rule
}

var fileTemplate = template.Must(template.New("permissions").Parse(`// Code generated by permgen from openapi/openapi.yaml. DO NOT EDIT.

package apigen

// AuthKind 表示一个接口需要的鉴权方式。
type AuthKind string

const (
	AuthNone       AuthKind = "none"
	AuthSession    AuthKind = "session"
	AuthPermission AuthKind = "permission"
)

// OperationAuth 是单个接口的鉴权规则。
type OperationAuth struct {
	Kind       AuthKind
	Permission string
	Access     string
}

// OperationAuths 的键是 strict 中间件收到的 operationID（首字母大写的 operationId）。
var OperationAuths = map[string]OperationAuth{
{{- range .}}
	{{printf "%q" .Name}}: {Kind: {{.Kind}}{{if .Permission}}, Permission: {{printf "%q" .Permission}}, Access: {{printf "%q" .Access}}{{end}}},
{{- end}}
}
`))

func render(rules map[string]rule) ([]byte, error) {
	entries := make([]entry, 0, len(rules))
	for name, r := range rules {
		entries = append(entries, entry{Name: name, rule: r})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })

	var buf bytes.Buffer
	if err := fileTemplate.Execute(&buf, entries); err != nil {
		return nil, err
	}
	return format.Source(buf.Bytes())
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `cd api && go test ./internal/httpapi/cmd/permgen/`
Expected: `ok  	werun/api/internal/httpapi/cmd/permgen`

- [ ] **Step 6: 写 OpenAPI 规范与生成配置**

`api/openapi/openapi.yaml`：

```yaml
openapi: 3.0.3
info:
  title: WeRun API
  version: 0.1.0
servers:
  - url: /api
paths:
  /healthz:
    get:
      operationId: getHealthz
      tags: [system]
      summary: 进程存活检查
      responses:
        "200":
          description: 进程存活
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Health"
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
  /readyz:
    get:
      operationId: getReadyz
      tags: [system]
      summary: 数据库连通检查
      responses:
        "200":
          description: 可以接收流量
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Health"
        "503":
          description: 数据库不可用
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Health"
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
components:
  schemas:
    ErrorResponse:
      type: object
      required: [error]
      properties:
        error:
          type: object
          required: [code, message]
          properties:
            code:
              type: string
            message:
              type: string
            fields:
              type: object
              additionalProperties:
                type: string
    Health:
      type: object
      required: [status]
      properties:
        status:
          type: string
```

`api/openapi/oapi-codegen.yaml`：

```yaml
package: apigen
output: ../internal/httpapi/apigen/api.gen.go
generate:
  gin-server: true
  strict-server: true
  models: true
  embedded-spec: false
compatibility:
  always-prefix-enum-values: true
```

- [ ] **Step 7: 在 Makefile 中加入生成目标**

在根 `Makefile` 末尾追加（命令行首必须是 Tab）：

```make
.PHONY: gen gen-api

gen: gen-api

gen-api:
	mkdir -p api/internal/httpapi/apigen
	cd api/openapi && go tool oapi-codegen -config oapi-codegen.yaml openapi.yaml
	cd api && go run ./internal/httpapi/cmd/permgen -spec openapi/openapi.yaml -out internal/httpapi/apigen/permissions.gen.go
```

- [ ] **Step 8: 生成代码并确认可以编译**

Run:

```bash
make gen-api
cd api && go build ./internal/httpapi/apigen/
```

Expected：无输出、退出码 0。`api/internal/httpapi/apigen/api.gen.go` 中包含 `type StrictServerInterface interface`，其方法为 `GetHealthz(ctx context.Context, request GetHealthzRequestObject) (GetHealthzResponseObject, error)` 与 `GetReadyz(...)`；存在类型 `GetHealthz200JSONResponse Health`、`GetReadyz200JSONResponse Health`、`GetReadyz503JSONResponse Health`。

`api/internal/httpapi/apigen/permissions.gen.go` 的映射部分应为：

```go
var OperationAuths = map[string]OperationAuth{
	"GetHealthz": {Kind: AuthNone},
	"GetReadyz":  {Kind: AuthNone},
}
```

再执行一次 `make gen-api && git status --porcelain api/internal/httpapi/apigen`，Expected：第二次生成后没有新的改动（生成是确定性的）。

- [ ] **Step 9: 写 health 的失败测试**

`api/internal/httpapi/health_test.go`：

```go
package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/platform/logx"
)

func newHealthTestDeps(t *testing.T) RouterDeps {
	t.Helper()
	cat, err := i18n.LoadCatalog()
	require.NoError(t, err)
	return RouterDeps{
		Log:     logx.New("error", io.Discard),
		Catalog: cat,
		Pool:    dbtest.NewPool(t),
	}
}

func TestHealthHandlers_Healthz(t *testing.T) {
	h := NewHealthHandlers(nil)
	resp, err := h.GetHealthz(context.Background(), apigen.GetHealthzRequestObject{})
	require.NoError(t, err)
	assert.Equal(t, apigen.GetHealthz200JSONResponse{Status: "ok"}, resp)
}

func TestHealthHandlers_ReadyzOK(t *testing.T) {
	deps := newHealthTestDeps(t)
	resp, err := NewHealthHandlers(deps.Pool).GetReadyz(context.Background(), apigen.GetReadyzRequestObject{})
	require.NoError(t, err)
	assert.Equal(t, apigen.GetReadyz200JSONResponse{Status: "ok"}, resp)
}

func TestRouter_ReadyzUnavailableWhenPoolClosed(t *testing.T) {
	deps := newHealthTestDeps(t)
	deps.Pool.Close()
	router := NewRouter(deps)

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/readyz", nil))

	assert.Equal(t, http.StatusServiceUnavailable, rec.Code)
	var body apigen.Health
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "unavailable", body.Status)
}

func TestRouter_HealthzThroughGeneratedHandler(t *testing.T) {
	router := NewRouter(newHealthTestDeps(t))

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/healthz", nil))

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{"status":"ok"}`, rec.Body.String())
	assert.NotEmpty(t, rec.Header().Get("X-Request-ID"))
}

func TestServerImplementsStrictInterface(t *testing.T) {
	var _ apigen.StrictServerInterface = (*Server)(nil)
}
```

- [ ] **Step 10: 运行测试，确认失败**

Run: `cd api && go test ./internal/httpapi/ -run 'TestHealthHandlers|TestRouter_Readyz|TestRouter_HealthzThrough|TestServerImplements'`
Expected: FAIL，编译错误 `undefined: NewHealthHandlers`、`undefined: Server`。

- [ ] **Step 11: 实现 health、Server，并把路由改为挂载生成的 strict handler**

`api/internal/httpapi/health.go`：

```go
package httpapi

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"werun/api/internal/httpapi/apigen"
)

// HealthHandlers 实现 getHealthz / getReadyz。
type HealthHandlers struct {
	pool *pgxpool.Pool
}

func NewHealthHandlers(pool *pgxpool.Pool) *HealthHandlers {
	return &HealthHandlers{pool: pool}
}

func (h *HealthHandlers) GetHealthz(ctx context.Context, _ apigen.GetHealthzRequestObject) (apigen.GetHealthzResponseObject, error) {
	return apigen.GetHealthz200JSONResponse{Status: "ok"}, nil
}

func (h *HealthHandlers) GetReadyz(ctx context.Context, _ apigen.GetReadyzRequestObject) (apigen.GetReadyzResponseObject, error) {
	pingCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if err := h.pool.Ping(pingCtx); err != nil {
		return apigen.GetReadyz503JSONResponse{Status: "unavailable"}, nil
	}
	return apigen.GetReadyz200JSONResponse{Status: "ok"}, nil
}
```

`api/internal/httpapi/server.go`：

```go
package httpapi

import "werun/api/internal/httpapi/apigen"

// Server 组合各模块的 handler，实现 apigen.StrictServerInterface。
// 新增模块时在这里嵌入该模块的 handler，并在 NewServer 中构造。
type Server struct {
	*HealthHandlers
}

var _ apigen.StrictServerInterface = (*Server)(nil)

// NewServer 用路由依赖构造全部模块 handler。
func NewServer(d RouterDeps) *Server {
	return &Server{
		HealthHandlers: NewHealthHandlers(d.Pool),
	}
}
```

用下面内容**整体替换** `api/internal/httpapi/router.go`（Task 4 手写的 healthz / readyz 路由与处理函数一并删除，行为由生成代码接管）：

```go
package httpapi

import (
	"log/slog"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
)

// RouterDeps 是构造 HTTP 路由所需的依赖。
type RouterDeps struct {
	Log     *slog.Logger
	Catalog *i18n.Catalog
	Pool    *pgxpool.Pool
	Server  *Server // 为 nil 时由 NewServer 构造
}

// trustedProxies：只信任本机与私有网段（compose 网络里的 Caddy）转发的 X-Forwarded-For，
// 这样 c.ClientIP() 才是真实客户端 IP，登录限流按人计算。以后在 Caddy 前面加 Cloudflare 时，由 Caddy 的 trusted_proxies 处理。
var trustedProxies = []string{"127.0.0.1/32", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"}

// NewRouter 组装中间件与 apigen 生成的路由，所有接口挂在 /api 下。
func NewRouter(d RouterDeps) *gin.Engine {
	engine := gin.New()
	if err := engine.SetTrustedProxies(trustedProxies); err != nil {
		panic(err) // 列表是常量，出错说明代码写错了
	}
	engine.Use(
		httpx.RequestID(),
		httpx.AccessLog(d.Log),
		httpx.Recover(d.Catalog, d.Log),
		httpx.Locale(),
	)

	server := d.Server
	if server == nil {
		server = NewServer(d)
	}

	writeErr := func(c *gin.Context, err error) {
		httpx.WriteError(c, d.Catalog, d.Log, err)
	}
	strict := apigen.NewStrictHandlerWithOptions(server, nil, apigen.StrictGinServerOptions{
		RequestErrorHandlerFunc: func(c *gin.Context, err error) {
			writeErr(c, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest).Wrap(err))
		},
		HandlerErrorFunc:         writeErr,
		ResponseErrorHandlerFunc: writeErr,
	})
	apigen.RegisterHandlersWithOptions(engine, strict, apigen.GinServerOptions{
		BaseURL: "/api",
		ErrorHandler: func(c *gin.Context, err error, status int) {
			writeErr(c, apperr.New(status, apperr.CodeBadRequest).Wrap(err))
		},
	})
	// 保留 Task 4 的行为：未知路径返回按语言翻译的 NOT_FOUND
	engine.NoRoute(func(c *gin.Context) {
		writeErr(c, apperr.New(http.StatusNotFound, apperr.CodeNotFound))
	})
	return engine
}
```

- [ ] **Step 12: 运行 httpapi 全部测试（含 Task 4 的路由测试）**

Run: `cd api && go test ./internal/httpapi/...`
Expected: `ok  	werun/api/internal/httpapi`、`ok  	werun/api/internal/httpapi/cmd/permgen`（`apigen` 显示 `[no test files]`）。

- [ ] **Step 13: 全量测试与 lint**

Run: `make test-api && make lint-api`
Expected：全部通过，golangci-lint 输出 `0 issues.`

- [ ] **Step 14: 提交**

```bash
git add Makefile api/go.mod api/go.sum api/openapi api/internal/httpapi
git commit -F - <<'EOF'
feat(api): add OpenAPI contract, generated strict server and permgen

- openapi.yaml with getHealthz/getReadyz, oapi-codegen strict gin server in apigen
- permgen validates x-auth / x-permission / x-access and emits OperationAuths
- router mounts generated handlers; all errors go through httpx.WriteError

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
```

---
### Task 6: 角色、权限矩阵与密码哈希

**Files:**
- Create: `api/internal/iam/roles.go`
- Create: `api/internal/iam/matrix.go`
- Create: `api/internal/iam/password.go`
- Test: `api/internal/iam/matrix_test.go`
- Test: `api/internal/iam/password_test.go`
- Modify: `api/go.mod`、`api/go.sum`

**Interfaces:**
- Consumes：无（纯 Go，不依赖前面任务的包）
- Produces（C8、C9）：
  - `iam.Role` 与常量 `RoleAdmin`、`RoleOps`、`RoleFinance`、`RoleSupport`、`RoleRaceSupervisor`、`RoleRaceStaff`、`RolePhotographer`；`iam.AllRoles []Role`；`iam.ParseRole(s string) (Role, bool)`
  - `iam.Access` 与常量 `AccessRead = "read"`、`AccessWrite = "write"`
  - `iam.Permission` 与 32 个常量（`PermEventConfig = "event_config"` 等）；`iam.AllPermissions []Permission`
  - `iam.Allowed(role Role, p Permission, need Access) bool`、`iam.PermissionsOf(role Role) map[Permission]Access`
  - `iam.HashPassword(password string) (string, error)`、`iam.VerifyPassword(encoded, password string) (bool, error)`、`iam.ErrMalformedHash`

矩阵来源：`requirements/run/admin.html` 第 753–789 行的 `PERM`，列顺序 ADMIN, OPS, FINANCE, SUPPORT, RACE_SUPERVISOR, RACE_STAFF, PHOTOGRAPHER；`"W"` → `AccessWrite`，`"R"` → `AccessRead`，`""` → 无权限。

- [ ] **Step 1: 确认 argon2 依赖**

```bash
cd api && go get golang.org/x/crypto@v0.57.0
```

Expected：`go.mod` 中 `golang.org/x/crypto v0.57.0`（若 Task 1 已添加则无变化）。

- [ ] **Step 2: 写权限矩阵的失败测试**

`api/internal/iam/matrix_test.go`：

```go
package iam

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestMatrixCellsMatchDemo(t *testing.T) {
	cases := []struct {
		perm Permission
		want map[Role]Access // 未列出的角色必须没有该权限
	}{
		{PermEventConfig, map[Role]Access{RoleAdmin: AccessRead, RoleOps: AccessWrite, RoleFinance: AccessRead}},
		{PermEventPublish, map[Role]Access{RoleAdmin: AccessRead, RoleOps: AccessWrite, RoleSupport: AccessRead}},
		{PermRefundSettle, map[Role]Access{RoleOps: AccessRead, RoleFinance: AccessWrite, RoleSupport: AccessRead}},
		{PermRacepackIssue, map[Role]Access{RoleOps: AccessRead, RoleSupport: AccessRead, RoleRaceSupervisor: AccessWrite, RoleRaceStaff: AccessWrite}},
		{PermPhotoUpload, map[Role]Access{RoleAdmin: AccessRead, RoleOps: AccessWrite, RolePhotographer: AccessWrite}},
		{PermAccessManage, map[Role]Access{RoleAdmin: AccessWrite}},
		{PermAuditView, map[Role]Access{RoleAdmin: AccessWrite, RoleOps: AccessRead, RoleFinance: AccessRead}},
	}
	for _, tc := range cases {
		t.Run(string(tc.perm), func(t *testing.T) {
			for _, role := range AllRoles {
				got, has := PermissionsOf(role)[tc.perm]
				want, shouldHave := tc.want[role]
				assert.Equal(t, shouldHave, has, "role %s", role)
				assert.Equal(t, want, got, "role %s", role)
			}
		})
	}
}

func TestAllPermissionsCount(t *testing.T) {
	assert.Len(t, AllPermissions, 32)
	assert.Len(t, matrix, 32)
}

func TestEveryPermissionGrantedToSomeRole(t *testing.T) {
	for _, p := range AllPermissions {
		granted := false
		for _, role := range AllRoles {
			if Allowed(role, p, AccessRead) {
				granted = true
			}
		}
		assert.True(t, granted, "permission %s is granted to no role", p)
	}
}

func TestAllowedSemantics(t *testing.T) {
	assert.True(t, Allowed(RoleOps, PermEventConfig, AccessWrite))
	assert.True(t, Allowed(RoleOps, PermEventConfig, AccessRead), "write implies read")
	assert.True(t, Allowed(RoleAdmin, PermEventConfig, AccessRead))
	assert.False(t, Allowed(RoleAdmin, PermEventConfig, AccessWrite), "read does not imply write")
	assert.False(t, Allowed(RoleSupport, PermEventConfig, AccessRead))
	assert.False(t, Allowed(RoleOps, Permission("unknown"), AccessRead))
	assert.False(t, Allowed(Role("GHOST"), PermEventConfig, AccessRead))
	assert.False(t, Allowed(RoleOps, PermEventConfig, Access("delete")))
}

func TestPermissionsOfOps(t *testing.T) {
	perms := PermissionsOf(RoleOps)
	assert.Equal(t, AccessWrite, perms[PermEventConfig])
	assert.Equal(t, AccessWrite, perms[PermEventPublish])
	_, hasManualConfirm := perms[PermManualConfirm]
	assert.False(t, hasManualConfirm)
}

func TestParseRole(t *testing.T) {
	r, ok := ParseRole("RACE_STAFF")
	assert.True(t, ok)
	assert.Equal(t, RoleRaceStaff, r)
	_, ok = ParseRole("ops")
	assert.False(t, ok)
	assert.Len(t, AllRoles, 7)
}
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `cd api && go test ./internal/iam/`
Expected: FAIL，编译错误 `undefined: Permission`、`undefined: AllRoles`、`undefined: PermissionsOf` 等。

- [ ] **Step 4: 实现角色与矩阵**

`api/internal/iam/roles.go`：

```go
package iam

// Role 是后台员工角色，与 staff.role 的 CHECK 约束一致。
type Role string

const (
	RoleAdmin          Role = "ADMIN"
	RoleOps            Role = "OPS"
	RoleFinance        Role = "FINANCE"
	RoleSupport        Role = "SUPPORT"
	RoleRaceSupervisor Role = "RACE_SUPERVISOR"
	RoleRaceStaff      Role = "RACE_STAFF"
	RolePhotographer   Role = "PHOTOGRAPHER"
)

// AllRoles 的顺序与 Demo 权限矩阵的列顺序一致。
var AllRoles = []Role{
	RoleAdmin,
	RoleOps,
	RoleFinance,
	RoleSupport,
	RoleRaceSupervisor,
	RoleRaceStaff,
	RolePhotographer,
}

// ParseRole 只接受大写的完整角色名。
func ParseRole(s string) (Role, bool) {
	for _, r := range AllRoles {
		if string(r) == s {
			return r, true
		}
	}
	return "", false
}

// Access 是某个角色对某个权限的访问级别。
type Access string

const (
	AccessRead  Access = "read"
	AccessWrite Access = "write"
)
```

`api/internal/iam/matrix.go`：

```go
package iam

// Permission 是后台操作权限名，逐项对应 Demo requirements/run/admin.html 的 PERM 表。
type Permission string

const (
	PermEventPublish       Permission = "event_publish"
	PermEventConfig        Permission = "event_config"
	PermOrderView          Permission = "order_view"
	PermRosterExport       Permission = "roster_export"
	PermManualConfirm      Permission = "manual_confirm"
	PermRefundRequest      Permission = "refund_request"
	PermRefundReject       Permission = "refund_reject"
	PermRefundApprove      Permission = "refund_approve"
	PermRefundSettle       Permission = "refund_settle"
	PermExceptionReturn    Permission = "exception_return"
	PermPrepayCancel       Permission = "prepay_cancel"
	PermOrderArchive       Permission = "order_archive"
	PermBibAssign          Permission = "bib_assign"
	PermBibSwap            Permission = "bib_swap"
	PermBibVoid            Permission = "bib_void"
	PermRacepackIssue      Permission = "racepack_issue"
	PermRacepackUndo       Permission = "racepack_undo"
	PermOfflineConflict    Permission = "offline_conflict"
	PermResultImport       Permission = "result_import"
	PermResultPublish      Permission = "result_publish"
	PermResultUnpublish    Permission = "result_unpublish"
	PermClaimCaseCreate    Permission = "claim_case_create"
	PermClaimBind          Permission = "claim_bind"
	PermPhotoUpload        Permission = "photo_upload"
	PermPhotoTag           Permission = "photo_tag"
	PermPhotoRemovalReview Permission = "photo_removal_review"
	PermContentManage      Permission = "content_manage"
	PermAccessManage       Permission = "access_manage"
	PermReconClose         Permission = "recon_close"
	PermReconResolve       Permission = "recon_resolve"
	PermRefundCorrection   Permission = "refund_correction"
	PermAuditView          Permission = "audit_view"
)

// AllPermissions 与 Demo PERM 表的行顺序一致。
var AllPermissions = []Permission{
	PermEventPublish,
	PermEventConfig,
	PermOrderView,
	PermRosterExport,
	PermManualConfirm,
	PermRefundRequest,
	PermRefundReject,
	PermRefundApprove,
	PermRefundSettle,
	PermExceptionReturn,
	PermPrepayCancel,
	PermOrderArchive,
	PermBibAssign,
	PermBibSwap,
	PermBibVoid,
	PermRacepackIssue,
	PermRacepackUndo,
	PermOfflineConflict,
	PermResultImport,
	PermResultPublish,
	PermResultUnpublish,
	PermClaimCaseCreate,
	PermClaimBind,
	PermPhotoUpload,
	PermPhotoTag,
	PermPhotoRemovalReview,
	PermContentManage,
	PermAccessManage,
	PermReconClose,
	PermReconResolve,
	PermRefundCorrection,
	PermAuditView,
}

// matrix 逐格照抄 admin.html 第 753–789 行。
// 列顺序：ADMIN, OPS, FINANCE, SUPPORT, RACE_SUPERVISOR, RACE_STAFF, PHOTOGRAPHER。
var matrix = map[Permission]map[Role]Access{
	PermEventPublish:       row("R", "W", "", "R", "", "", ""),
	PermEventConfig:        row("R", "W", "R", "", "", "", ""),
	PermOrderView:          row("R", "R", "R", "R", "R", "R", ""),
	PermRosterExport:       row("R", "W", "", "", "W", "", ""),
	PermManualConfirm:      row("", "", "W", "", "", "", ""),
	PermRefundRequest:      row("", "", "W", "W", "", "", ""),
	PermRefundReject:       row("", "", "W", "R", "", "", ""),
	PermRefundApprove:      row("", "R", "W", "R", "", "", ""),
	PermRefundSettle:       row("", "R", "W", "R", "", "", ""),
	PermExceptionReturn:    row("", "", "W", "R", "", "", ""),
	PermPrepayCancel:       row("R", "W", "R", "W", "", "", ""),
	PermOrderArchive:       row("R", "W", "R", "R", "", "", ""),
	PermBibAssign:          row("R", "W", "", "", "", "", ""),
	PermBibSwap:            row("R", "W", "", "", "W", "", ""),
	PermBibVoid:            row("R", "W", "", "", "", "", ""),
	PermRacepackIssue:      row("", "R", "", "R", "W", "W", ""),
	PermRacepackUndo:       row("", "W", "", "", "W", "", ""),
	PermOfflineConflict:    row("R", "W", "", "", "W", "", ""),
	PermResultImport:       row("R", "W", "", "R", "", "", ""),
	PermResultPublish:      row("R", "W", "", "R", "", "", ""),
	PermResultUnpublish:    row("W", "W", "", "", "", "", ""),
	PermClaimCaseCreate:    row("R", "W", "", "W", "", "", ""),
	PermClaimBind:          row("R", "W", "", "R", "", "", ""),
	PermPhotoUpload:        row("R", "W", "", "", "", "", "W"),
	PermPhotoTag:           row("R", "W", "", "", "", "", "W"),
	PermPhotoRemovalReview: row("W", "W", "", "", "", "", ""),
	PermContentManage:      row("R", "W", "", "", "", "", ""),
	PermAccessManage:       row("W", "", "", "", "", "", ""),
	PermReconClose:         row("R", "", "W", "", "", "", ""),
	PermReconResolve:       row("R", "", "W", "", "", "", ""),
	PermRefundCorrection:   row("", "", "W", "R", "", "", ""),
	PermAuditView:          row("W", "R", "R", "", "", "", ""),
}

func row(admin, ops, finance, support, raceSupervisor, raceStaff, photographer string) map[Role]Access {
	cells := []string{admin, ops, finance, support, raceSupervisor, raceStaff, photographer}
	out := make(map[Role]Access, len(AllRoles))
	for i, cell := range cells {
		switch cell {
		case "W":
			out[AllRoles[i]] = AccessWrite
		case "R":
			out[AllRoles[i]] = AccessRead
		}
	}
	return out
}

// Allowed：need=read 时 W 或 R 均可；need=write 时只有 W。
func Allowed(role Role, p Permission, need Access) bool {
	got, ok := matrix[p][role]
	if !ok {
		return false
	}
	switch need {
	case AccessWrite:
		return got == AccessWrite
	case AccessRead:
		return got == AccessRead || got == AccessWrite
	default:
		return false
	}
}

// PermissionsOf 返回该角色有 R 或 W 的全部权限。
func PermissionsOf(role Role) map[Permission]Access {
	out := make(map[Permission]Access)
	for _, p := range AllPermissions {
		if a, ok := matrix[p][role]; ok {
			out[p] = a
		}
	}
	return out
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `cd api && go test ./internal/iam/ -run 'TestMatrix|TestAllPermissions|TestEveryPermission|TestAllowed|TestPermissionsOf|TestParseRole'`
Expected: `ok  	werun/api/internal/iam`

- [ ] **Step 6: 写密码哈希的失败测试**

`api/internal/iam/password_test.go`：

```go
package iam

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestHashPasswordRoundTrip(t *testing.T) {
	hash, err := HashPassword("correct-horse-1")
	require.NoError(t, err)

	ok, err := VerifyPassword(hash, "correct-horse-1")
	require.NoError(t, err)
	assert.True(t, ok)
}

func TestVerifyPasswordWrongPassword(t *testing.T) {
	hash, err := HashPassword("correct-horse-1")
	require.NoError(t, err)

	ok, err := VerifyPassword(hash, "correct-horse-2")
	require.NoError(t, err)
	assert.False(t, ok)
}

func TestHashPasswordEncodesParameters(t *testing.T) {
	hash, err := HashPassword("correct-horse-1")
	require.NoError(t, err)
	assert.True(t, strings.HasPrefix(hash, "$argon2id$v=19$m=65536,t=3,p=2$"), hash)

	other, err := HashPassword("correct-horse-1")
	require.NoError(t, err)
	assert.NotEqual(t, hash, other, "salt must be random")
}

func TestVerifyPasswordMalformedHash(t *testing.T) {
	for _, bad := range []string{
		"",
		"plain-text",
		"$argon2i$v=19$m=65536,t=3,p=2$c2FsdA$aGFzaA",
		"$argon2id$v=18$m=65536,t=3,p=2$c2FsdA$aGFzaA",
		"$argon2id$v=19$m=x,t=3,p=2$c2FsdA$aGFzaA",
		"$argon2id$v=19$m=65536,t=3,p=2$!!!$aGFzaA",
		"$argon2id$v=19$m=65536,t=3,p=2$c2FsdA$",
	} {
		ok, err := VerifyPassword(bad, "anything")
		assert.ErrorIs(t, err, ErrMalformedHash, bad)
		assert.False(t, ok)
	}
}
```

- [ ] **Step 7: 运行测试，确认失败**

Run: `cd api && go test ./internal/iam/ -run 'Password'`
Expected: FAIL，编译错误 `undefined: HashPassword`、`undefined: VerifyPassword`、`undefined: ErrMalformedHash`。

- [ ] **Step 8: 实现 argon2id 哈希**

`api/internal/iam/password.go`：

```go
package iam

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// argon2id 参数取自 spec §5.4。
const (
	argonTime    uint32 = 3
	argonMemory  uint32 = 64 * 1024 // KiB，即 64MB
	argonThreads uint8  = 2
	argonSaltLen        = 16
	argonKeyLen  uint32 = 32
)

// ErrMalformedHash 表示库里存的密码哈希不是本包生成的格式。
var ErrMalformedHash = errors.New("iam: malformed password hash")

// HashPassword 返回 PHC 格式字符串：$argon2id$v=19$m=65536,t=3,p=2$<salt>$<hash>。
func HashPassword(password string) (string, error) {
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("iam: generate salt: %w", err)
	}
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemory, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	), nil
}

// VerifyPassword 按哈希里记录的参数重新计算并做常量时间比较。
func VerifyPassword(encoded, password string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[0] != "" || parts[1] != "argon2id" {
		return false, ErrMalformedHash
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return false, ErrMalformedHash
	}
	var memory, iterations uint32
	var threads uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &iterations, &threads); err != nil {
		return false, ErrMalformedHash
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil || len(salt) == 0 {
		return false, ErrMalformedHash
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil || len(want) == 0 {
		return false, ErrMalformedHash
	}
	got := argon2.IDKey([]byte(password), salt, iterations, memory, threads, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}
```

- [ ] **Step 9: 运行 iam 全部测试与 lint**

Run: `cd api && go test ./internal/iam/ && go tool golangci-lint run ./internal/iam/...`
Expected: `ok  	werun/api/internal/iam`，lint 输出 `0 issues.`

- [ ] **Step 10: 提交**

```bash
git add api/go.mod api/go.sum api/internal/iam
git commit -F - <<'EOF'
feat(iam): add role/permission matrix from demo and argon2id password hashing

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
```

---

### Task 7: sqlc 查询、审计写入、登录限流与会话服务

**Files:**
- Create: `api/sqlc.yaml`
- Create: `api/db/queries/iam.sql`
- Create（生成）: `api/internal/iam/store/db.go`、`models.go`、`iam.sql.go`
- Create: `api/internal/audit/audit.go`
- Test: `api/internal/audit/audit_test.go`
- Create: `api/internal/iam/limiter.go`
- Test: `api/internal/iam/limiter_test.go`
- Create: `api/internal/iam/service.go`
- Test: `api/internal/iam/service_test.go`
- Modify: `Makefile`（`gen-api` 追加 sqlc）

**Interfaces:**
- Consumes：
  - `apperr.New`、`(*Error).WithField(field, key string, params map[string]any)`、`apperr.FromPG(err) error`、`apperr.RegisterConstraint(name string, build func() *apperr.Error)`、`apperr.As`、`apperr.CodeValidation|CodeRateLimited|CodeAccountLocked|CodeInvalidCredentials|CodeUnauthenticated`（C3）
  - `httpx.Meta{RequestID, IP, UserAgent string}`（C5）
  - `db.InTx(ctx, pool, func(tx pgx.Tx) error) error`、`dbtest.NewPool(t)`（C6）
  - Task 6：`iam.Role`、`iam.ParseRole`、`iam.RoleOps`、`iam.RoleAdmin`、`iam.HashPassword`、`iam.VerifyPassword`
- Produces：
  - `audit.Entry`、`audit.Record(ctx context.Context, tx pgx.Tx, e audit.Entry) error`（C10）
  - `iam.Clock`、`iam.LoginLimiter`、`iam.NewLoginLimiter(clock Clock) *LoginLimiter`、`AllowIP`、`Locked`、`Failure`、`Success`（C9）
  - `iam.CookieName`、`iam.CookiePath`、`iam.IdleTimeout`、`iam.AbsoluteTimeout`、`iam.TouchInterval`、`iam.Staff`
  - `iam.Service`、`iam.NewService(pool *pgxpool.Pool, sessionSecret []byte, limiter *LoginLimiter, clock Clock) *Service`，方法 `CreateStaff`、`Login`、`Authenticate`、`Logout`、`DeleteExpiredSessions`（签名见 C9；Task 9 的 `jobs.SessionCleaner` 依赖 `DeleteExpiredSessions`）
  - sqlc 生成的 `store.New(db store.DBTX) *store.Queries`、`(*Queries).WithTx(tx pgx.Tx) *Queries`

**实现要点（已用临时模块 + 真实 PostgreSQL 16 跑通全部测试）：**
- sessions 表没有"最后活跃时间"列，按 C9 用滑动更新 `expires_at` 实现空闲过期；登录时 `created_at` 用注入的时钟写入，绝对过期按 `created_at + 7 天` 计算。
- 用户名不存在时也执行一次 argon2 校验（固定假哈希），避免通过响应时间判断用户名是否存在；同时计入该用户名的失败次数。
- 用户名唯一约束 `staff_username_key` 注册为字段 `username` 的校验错误（C3 没有专门的错误码，沿用 `VALIDATION_FAILED`）。
- 登录成功时"写会话 + 更新 last_login_at + 写审计"在同一个事务里；登录失败的审计单独一个事务。

- [ ] **Step 1: 写 sqlc 配置与查询**

`api/sqlc.yaml`：

```yaml
version: "2"
sql:
  - engine: postgresql
    schema: db/migrations
    queries: db/queries/iam.sql
    gen:
      go:
        package: store
        out: internal/iam/store
        sql_package: pgx/v5
        emit_pointers_for_null_types: true
        overrides:
          - db_type: timestamptz
            go_type: time.Time
          - db_type: timestamptz
            nullable: true
            go_type:
              type: time.Time
              pointer: true
          - db_type: date
            go_type: time.Time
          - db_type: inet
            nullable: true
            go_type:
              import: net/netip
              type: Addr
              pointer: true
```

`api/db/queries/iam.sql`：

```sql
-- name: GetStaffByUsername :one
SELECT id, username, full_name, role, password_hash, status
FROM staff
WHERE username = @username;

-- name: InsertStaff :one
INSERT INTO staff (username, full_name, role, password_hash)
VALUES (@username, @full_name, @role, @password_hash)
RETURNING id, username, full_name, role;

-- name: SetStaffLastLogin :exec
UPDATE staff SET last_login_at = @last_login_at WHERE id = @id;

-- name: InsertStaffSession :exec
INSERT INTO sessions (subject_type, subject_id, token_hash, expires_at, ip, user_agent, created_at)
VALUES ('STAFF', @staff_id, @token_hash, @expires_at, @ip, @user_agent, @created_at);

-- name: GetStaffSession :one
SELECT s.id AS session_id,
       s.expires_at,
       s.created_at,
       s.revoked_at,
       st.id AS staff_id,
       st.username,
       st.full_name,
       st.role,
       st.status
FROM sessions s
JOIN staff st ON st.id = s.subject_id
WHERE s.subject_type = 'STAFF'
  AND s.token_hash = @token_hash;

-- name: UpdateSessionExpiry :exec
UPDATE sessions SET expires_at = @expires_at
WHERE id = @id AND revoked_at IS NULL;

-- name: RevokeSession :exec
UPDATE sessions SET revoked_at = @revoked_at
WHERE token_hash = @token_hash AND revoked_at IS NULL;

-- name: DeleteExpiredSessions :execrows
DELETE FROM sessions
WHERE expires_at < @cutoff
   OR revoked_at < @cutoff;
```

在根 `Makefile` 的 `gen-api` 目标末尾追加一行（行首是 Tab）：

```make
	cd api && go tool sqlc generate
```

- [ ] **Step 2: 生成查询代码**

Run: `make gen-api && cd api && go build ./internal/iam/store/`
Expected：生成 `api/internal/iam/store/db.go`、`models.go`、`iam.sql.go`，编译通过。`iam.sql.go` 中应包含以下签名（后续代码依赖这些名字）：

```go
func (q *Queries) GetStaffByUsername(ctx context.Context, username string) (GetStaffByUsernameRow, error)
func (q *Queries) InsertStaff(ctx context.Context, arg InsertStaffParams) (InsertStaffRow, error)
func (q *Queries) SetStaffLastLogin(ctx context.Context, arg SetStaffLastLoginParams) error     // LastLoginAt *time.Time, ID int64
func (q *Queries) InsertStaffSession(ctx context.Context, arg InsertStaffSessionParams) error   // StaffID, TokenHash, ExpiresAt, Ip *netip.Addr, UserAgent *string, CreatedAt
func (q *Queries) GetStaffSession(ctx context.Context, tokenHash []byte) (GetStaffSessionRow, error) // SessionID, ExpiresAt, CreatedAt, RevokedAt *time.Time, StaffID, Username, FullName, Role, Status
func (q *Queries) UpdateSessionExpiry(ctx context.Context, arg UpdateSessionExpiryParams) error // ExpiresAt, ID
func (q *Queries) RevokeSession(ctx context.Context, arg RevokeSessionParams) error             // RevokedAt *time.Time, TokenHash
func (q *Queries) DeleteExpiredSessions(ctx context.Context, cutoff time.Time) (int64, error)
```

- [ ] **Step 3: 写审计的失败测试**

`api/internal/audit/audit_test.go`：

```go
package audit

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/db"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/httpx"
)

func TestRecordInsertsRow(t *testing.T) {
	pool := dbtest.NewPool(t)
	ctx := context.Background()
	staffID := int64(42)
	role := "OPS"

	err := db.InTx(ctx, pool, func(tx pgx.Tx) error {
		return Record(ctx, tx, Entry{
			ActorType:  "STAFF",
			ActorID:    &staffID,
			ActorRole:  &role,
			Action:     "event.create",
			EntityType: "event",
			EntityID:   7,
			Summary:    "创建赛事 pphm-2026",
			After:      map[string]string{"slug": "pphm-2026"},
			Meta:       httpx.Meta{RequestID: "req-1", IP: "203.0.113.7", UserAgent: "go-test"},
		})
	})
	require.NoError(t, err)

	var (
		action, actorType, actorRole, requestID, ip, userAgent string
		actorID, entityID                                      int64
		after                                                  []byte
		before                                                 *string
	)
	err = pool.QueryRow(ctx, `
		SELECT action, actor_type, actor_id, actor_role, entity_id, after_data, before_data::text,
		       request_id, host(ip), user_agent
		FROM audit_logs`).
		Scan(&action, &actorType, &actorID, &actorRole, &entityID, &after, &before, &requestID, &ip, &userAgent)
	require.NoError(t, err)

	assert.Equal(t, "event.create", action)
	assert.Equal(t, "STAFF", actorType)
	assert.Equal(t, int64(42), actorID)
	assert.Equal(t, "OPS", actorRole)
	assert.Equal(t, int64(7), entityID)
	assert.JSONEq(t, `{"slug":"pphm-2026"}`, string(after))
	assert.Nil(t, before)
	assert.Equal(t, "req-1", requestID)
	assert.Equal(t, "203.0.113.7", ip)
	assert.Equal(t, "go-test", userAgent)
}

func TestRecordRollsBackWithTransaction(t *testing.T) {
	pool := dbtest.NewPool(t)
	ctx := context.Background()
	boom := errors.New("business failure")

	err := db.InTx(ctx, pool, func(tx pgx.Tx) error {
		if err := Record(ctx, tx, Entry{
			ActorType:  "SYSTEM",
			Action:     "event.publish",
			EntityType: "event",
			EntityID:   1,
			Summary:    "发布赛事",
		}); err != nil {
			return err
		}
		return boom
	})
	require.ErrorIs(t, err, boom)

	var n int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs`).Scan(&n))
	assert.Equal(t, 0, n)
}

func TestRecordWithoutOptionalFields(t *testing.T) {
	pool := dbtest.NewPool(t)
	ctx := context.Background()

	err := db.InTx(ctx, pool, func(tx pgx.Tx) error {
		return Record(ctx, tx, Entry{
			ActorType:  "SYSTEM",
			Action:     "staff.login_failed",
			EntityType: "staff",
			EntityID:   3,
			Summary:    "员工 ops.chan 登录失败：密码错误",
			Meta:       httpx.Meta{IP: "not-an-ip"},
		})
	})
	require.NoError(t, err)

	var actorID *int64
	var ip, requestID *string
	require.NoError(t, pool.QueryRow(ctx, `SELECT actor_id, host(ip), request_id FROM audit_logs`).Scan(&actorID, &ip, &requestID))
	assert.Nil(t, actorID)
	assert.Nil(t, ip)
	assert.Nil(t, requestID)
}
```

- [ ] **Step 4: 运行测试，确认失败**

Run: `cd api && go test ./internal/audit/`
Expected: FAIL，编译错误 `undefined: Record`、`undefined: Entry`。

- [ ] **Step 5: 实现审计写入**

`api/internal/audit/audit.go`：

```go
// Package audit 在调用方的事务里写 audit_logs。
package audit

import (
	"context"
	"encoding/json"
	"fmt"
	"net/netip"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/platform/httpx"
)

// Entry 对应 audit_logs 的一行。
type Entry struct {
	ActorType   string // "USER" | "STAFF" | "SYSTEM"
	ActorID     *int64
	ActorRole   *string
	Action      string
	EntityType  string
	EntityID    int64
	EventID     *int64
	IsFinancial bool
	Summary     string
	Before      any // 非 nil 时 JSON 编码写 before_data
	After       any // 非 nil 时 JSON 编码写 after_data
	Meta        httpx.Meta
}

const insertSQL = `INSERT INTO audit_logs
	(actor_type, actor_id, actor_role, action, entity_type, entity_id, event_id,
	 is_financial, summary, before_data, after_data, request_id, ip, user_agent)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`

// Record 必须传入事务：业务回滚时审计一起回滚。
func Record(ctx context.Context, tx pgx.Tx, e Entry) error {
	before, err := jsonOrNil(e.Before)
	if err != nil {
		return fmt.Errorf("audit: encode before_data for %s: %w", e.Action, err)
	}
	after, err := jsonOrNil(e.After)
	if err != nil {
		return fmt.Errorf("audit: encode after_data for %s: %w", e.Action, err)
	}
	_, err = tx.Exec(ctx, insertSQL,
		e.ActorType, e.ActorID, e.ActorRole, e.Action, e.EntityType, e.EntityID, e.EventID,
		e.IsFinancial, e.Summary, before, after,
		nilIfEmpty(e.Meta.RequestID), ipOrNil(e.Meta.IP), nilIfEmpty(e.Meta.UserAgent),
	)
	if err != nil {
		return fmt.Errorf("audit: insert %s: %w", e.Action, err)
	}
	return nil
}

func jsonOrNil(v any) (any, error) {
	if v == nil {
		return nil, nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return string(b), nil
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func ipOrNil(s string) any {
	addr, err := netip.ParseAddr(s)
	if err != nil {
		return nil
	}
	return addr
}
```

- [ ] **Step 6: 运行测试，确认通过**

Run: `cd api && go test ./internal/audit/`（需要本机 Docker）
Expected: `ok  	werun/api/internal/audit`

- [ ] **Step 7: 写限流器的失败测试**

`api/internal/iam/limiter_test.go`（其中的 `fakeClock` 供本包其它测试共用）：

```go
package iam

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

// fakeClock 供本包所有测试共用。
type fakeClock struct{ now time.Time }

func newFakeClock() *fakeClock {
	return &fakeClock{now: time.Date(2026, 9, 13, 8, 0, 0, 0, time.UTC)}
}

func (f *fakeClock) Now() time.Time          { return f.now }
func (f *fakeClock) Advance(d time.Duration) { f.now = f.now.Add(d) }

func TestAllowIPWindow(t *testing.T) {
	clock := newFakeClock()
	l := NewLoginLimiter(clock.Now)

	for i := 0; i < 20; i++ {
		assert.True(t, l.AllowIP("203.0.113.7"), "attempt %d", i+1)
	}
	assert.False(t, l.AllowIP("203.0.113.7"), "21st attempt within a minute")
	assert.True(t, l.AllowIP("198.51.100.1"), "other IPs are independent")

	clock.Advance(61 * time.Second)
	assert.True(t, l.AllowIP("203.0.113.7"), "window slides after a minute")
}

func TestFailuresLockAccount(t *testing.T) {
	clock := newFakeClock()
	l := NewLoginLimiter(clock.Now)

	for i := 0; i < 4; i++ {
		l.Failure("ops.chan")
	}
	assert.False(t, l.Locked("ops.chan"))

	l.Failure("ops.chan")
	assert.True(t, l.Locked("ops.chan"))

	clock.Advance(15*time.Minute - time.Second)
	assert.True(t, l.Locked("ops.chan"))

	clock.Advance(2 * time.Second)
	assert.False(t, l.Locked("ops.chan"), "lock expires after 15 minutes")
}

func TestFailuresOutsideWindowDoNotCount(t *testing.T) {
	clock := newFakeClock()
	l := NewLoginLimiter(clock.Now)

	for i := 0; i < 4; i++ {
		l.Failure("ops.chan")
	}
	clock.Advance(16 * time.Minute)
	l.Failure("ops.chan")
	assert.False(t, l.Locked("ops.chan"))
}

func TestSuccessResetsFailures(t *testing.T) {
	clock := newFakeClock()
	l := NewLoginLimiter(clock.Now)

	for i := 0; i < 4; i++ {
		l.Failure("ops.chan")
	}
	l.Success("ops.chan")
	for i := 0; i < 4; i++ {
		l.Failure("ops.chan")
	}
	assert.False(t, l.Locked("ops.chan"))
}
```

- [ ] **Step 8: 运行测试，确认失败**

Run: `cd api && go test ./internal/iam/ -run 'TestAllowIP|TestFailures|TestSuccess'`
Expected: FAIL，编译错误 `undefined: NewLoginLimiter`。

- [ ] **Step 9: 实现限流器**

`api/internal/iam/limiter.go`：

```go
package iam

import (
	"sync"
	"time"
)

// Clock 返回当前时间；生产用 time.Now，测试注入假时钟。
type Clock func() time.Time

// 限流参数取自 spec §5.4。
const (
	ipWindow      = time.Minute
	ipMaxAttempts = 20
	failureWindow = 15 * time.Minute
	maxFailures   = 5
	lockDuration  = 15 * time.Minute
)

// LoginLimiter 在内存里计数（一期单实例部署）。
type LoginLimiter struct {
	mu       sync.Mutex
	clock    Clock
	ipHits   map[string][]time.Time
	failures map[string][]time.Time
	locked   map[string]time.Time
}

func NewLoginLimiter(clock Clock) *LoginLimiter {
	return &LoginLimiter{
		clock:    clock,
		ipHits:   map[string][]time.Time{},
		failures: map[string][]time.Time{},
		locked:   map[string]time.Time{},
	}
}

// AllowIP 记录一次登录尝试；同一 IP 最近一分钟内已有 20 次时返回 false 且不计数。
func (l *LoginLimiter) AllowIP(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.clock()
	hits := pruneBefore(l.ipHits[ip], now.Add(-ipWindow))
	if len(hits) >= ipMaxAttempts {
		l.ipHits[ip] = hits
		return false
	}
	l.ipHits[ip] = append(hits, now)
	return true
}

// Locked 报告用户名当前是否处于锁定期。
func (l *LoginLimiter) Locked(username string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	until, ok := l.locked[username]
	if !ok {
		return false
	}
	if l.clock().Before(until) {
		return true
	}
	delete(l.locked, username)
	return false
}

// Failure 记录一次失败；15 分钟内累计第 5 次时锁定 15 分钟并清空计数。
func (l *LoginLimiter) Failure(username string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.clock()
	failures := append(pruneBefore(l.failures[username], now.Add(-failureWindow)), now)
	if len(failures) >= maxFailures {
		l.locked[username] = now.Add(lockDuration)
		delete(l.failures, username)
		return
	}
	l.failures[username] = failures
}

// Success 清除该用户名的失败计数与锁定。
func (l *LoginLimiter) Success(username string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.failures, username)
	delete(l.locked, username)
}

// pruneBefore 去掉不晚于 cutoff 的时间点（切片按时间递增）。
func pruneBefore(ts []time.Time, cutoff time.Time) []time.Time {
	i := 0
	for i < len(ts) && !ts[i].After(cutoff) {
		i++
	}
	return ts[i:]
}
```

- [ ] **Step 10: 运行测试，确认通过**

Run: `cd api && go test ./internal/iam/ -run 'TestAllowIP|TestFailures|TestSuccess'`
Expected: `ok  	werun/api/internal/iam`

- [ ] **Step 11: 写会话服务的失败测试**

`api/internal/iam/service_test.go`：

```go
package iam

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/httpx"
)

const testSecret = "0123456789abcdef0123456789abcdef"

var testMeta = httpx.Meta{RequestID: "req-test", IP: "203.0.113.7", UserAgent: "go-test"}

func newTestService(t *testing.T) (*Service, *fakeClock, *pgxpool.Pool) {
	t.Helper()
	pool := dbtest.NewPool(t)
	clock := newFakeClock()
	return NewService(pool, []byte(testSecret), NewLoginLimiter(clock.Now), clock.Now), clock, pool
}

func createOps(t *testing.T, svc *Service) Staff {
	t.Helper()
	staff, err := svc.CreateStaff(context.Background(), "ops.chan", "Chanthou Ny", RoleOps, "correct-horse-1")
	require.NoError(t, err)
	return staff
}

func requireCode(t *testing.T, err error, code string) *apperr.Error {
	t.Helper()
	appErr, ok := apperr.As(err)
	require.True(t, ok, "want *apperr.Error, got %v", err)
	assert.Equal(t, code, appErr.Code)
	return appErr
}

func countRows(t *testing.T, pool *pgxpool.Pool, query string, args ...any) int {
	t.Helper()
	var n int
	require.NoError(t, pool.QueryRow(context.Background(), query, args...).Scan(&n))
	return n
}

func sessionExpiry(t *testing.T, pool *pgxpool.Pool) time.Time {
	t.Helper()
	var expires time.Time
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT expires_at FROM sessions ORDER BY id LIMIT 1`).Scan(&expires))
	return expires
}

func TestCreateStaffValidation(t *testing.T) {
	svc, _, _ := newTestService(t)

	_, err := svc.CreateStaff(context.Background(), "Ops Chan", "", Role("GHOST"), "short")
	appErr := requireCode(t, err, apperr.CodeValidation)
	assert.Equal(t, "field.invalid", appErr.Fields["username"].Key)
	assert.Equal(t, "field.required", appErr.Fields["fullName"].Key)
	assert.Equal(t, "field.invalid", appErr.Fields["role"].Key)
	assert.Equal(t, "field.invalid", appErr.Fields["password"].Key)
}

func TestCreateStaffDuplicateUsername(t *testing.T) {
	svc, _, _ := newTestService(t)
	createOps(t, svc)

	_, err := svc.CreateStaff(context.Background(), "ops.chan", "Another", RoleAdmin, "correct-horse-2")
	appErr := requireCode(t, err, apperr.CodeValidation)
	assert.Equal(t, "field.invalid", appErr.Fields["username"].Key)
}

func TestLoginSuccess(t *testing.T) {
	svc, clock, pool := newTestService(t)
	ops := createOps(t, svc)

	token, staff, err := svc.Login(context.Background(), " OPS.CHAN ", "correct-horse-1", testMeta)
	require.NoError(t, err)
	assert.NotEmpty(t, token)
	assert.Equal(t, ops, staff)

	assert.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM sessions WHERE subject_type = 'STAFF' AND subject_id = $1`, ops.ID))
	assert.True(t, sessionExpiry(t, pool).Equal(clock.Now().Add(IdleTimeout)))
	assert.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM audit_logs WHERE action = 'staff.login' AND entity_id = $1`, ops.ID))
	assert.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM sessions WHERE token_hash = $1`, []byte(token)),
		"plain token must never be stored")
}

func TestLoginWrongPassword(t *testing.T) {
	svc, _, pool := newTestService(t)
	ops := createOps(t, svc)

	_, _, err := svc.Login(context.Background(), "ops.chan", "wrong-password", testMeta)
	requireCode(t, err, apperr.CodeInvalidCredentials)

	assert.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM sessions`))
	assert.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM audit_logs WHERE action = 'staff.login_failed' AND entity_id = $1 AND actor_type = 'SYSTEM'`, ops.ID))
}

func TestLoginUnknownUsername(t *testing.T) {
	svc, _, pool := newTestService(t)

	_, _, err := svc.Login(context.Background(), "nobody", "whatever-123", testMeta)
	requireCode(t, err, apperr.CodeInvalidCredentials)
	assert.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM audit_logs`))
}

func TestLoginLocksAfterFiveFailures(t *testing.T) {
	svc, clock, _ := newTestService(t)
	createOps(t, svc)
	ctx := context.Background()

	for i := 0; i < 5; i++ {
		_, _, err := svc.Login(ctx, "ops.chan", "wrong-password", testMeta)
		requireCode(t, err, apperr.CodeInvalidCredentials)
	}
	_, _, err := svc.Login(ctx, "ops.chan", "correct-horse-1", testMeta)
	requireCode(t, err, apperr.CodeAccountLocked)

	clock.Advance(15*time.Minute + time.Second)
	_, _, err = svc.Login(ctx, "ops.chan", "correct-horse-1", testMeta)
	require.NoError(t, err)
}

func TestLoginRateLimitedByIP(t *testing.T) {
	svc, _, _ := newTestService(t)
	ctx := context.Background()

	for i := 0; i < 20; i++ {
		_, _, err := svc.Login(ctx, fmt.Sprintf("user%02d", i), "whatever-123", testMeta)
		requireCode(t, err, apperr.CodeInvalidCredentials)
	}
	_, _, err := svc.Login(ctx, "user20", "whatever-123", testMeta)
	requireCode(t, err, apperr.CodeRateLimited)
}

func TestAuthenticateSlidingExpiry(t *testing.T) {
	svc, clock, pool := newTestService(t)
	ops := createOps(t, svc)
	ctx := context.Background()
	token, _, err := svc.Login(ctx, "ops.chan", "correct-horse-1", testMeta)
	require.NoError(t, err)
	loginAt := clock.Now()

	clock.Advance(30 * time.Second)
	staff, err := svc.Authenticate(ctx, token)
	require.NoError(t, err)
	assert.Equal(t, ops, staff)
	assert.True(t, sessionExpiry(t, pool).Equal(loginAt.Add(IdleTimeout)), "no write within TouchInterval")

	clock.Advance(90 * time.Second)
	_, err = svc.Authenticate(ctx, token)
	require.NoError(t, err)
	assert.True(t, sessionExpiry(t, pool).Equal(clock.Now().Add(IdleTimeout)), "extended after TouchInterval")
}

func TestAuthenticateIdleTimeout(t *testing.T) {
	svc, clock, _ := newTestService(t)
	createOps(t, svc)
	ctx := context.Background()
	token, _, err := svc.Login(ctx, "ops.chan", "correct-horse-1", testMeta)
	require.NoError(t, err)

	clock.Advance(IdleTimeout + time.Second)
	_, err = svc.Authenticate(ctx, token)
	requireCode(t, err, apperr.CodeUnauthenticated)
}

func TestAuthenticateAbsoluteTimeout(t *testing.T) {
	svc, clock, _ := newTestService(t)
	createOps(t, svc)
	ctx := context.Background()
	token, _, err := svc.Login(ctx, "ops.chan", "correct-horse-1", testMeta)
	require.NoError(t, err)

	// 每 7 小时活动一次，空闲从不超时；23 次后到达 161 小时。
	for i := 0; i < 23; i++ {
		clock.Advance(7 * time.Hour)
		_, err := svc.Authenticate(ctx, token)
		require.NoError(t, err, "hour %d", (i+1)*7)
	}
	clock.Advance(7 * time.Hour) // 168 小时 = 绝对过期时刻
	_, err = svc.Authenticate(ctx, token)
	requireCode(t, err, apperr.CodeUnauthenticated)
}

func TestAuthenticateRejectsGarbageToken(t *testing.T) {
	svc, _, _ := newTestService(t)
	_, err := svc.Authenticate(context.Background(), "not-a-token")
	requireCode(t, err, apperr.CodeUnauthenticated)
}

func TestLogoutRevokesSession(t *testing.T) {
	svc, _, _ := newTestService(t)
	createOps(t, svc)
	ctx := context.Background()
	token, _, err := svc.Login(ctx, "ops.chan", "correct-horse-1", testMeta)
	require.NoError(t, err)

	require.NoError(t, svc.Logout(ctx, token))
	_, err = svc.Authenticate(ctx, token)
	requireCode(t, err, apperr.CodeUnauthenticated)

	assert.NoError(t, svc.Logout(ctx, "garbage"))
}

func TestDeleteExpiredSessions(t *testing.T) {
	svc, clock, pool := newTestService(t)
	createOps(t, svc)
	ctx := context.Background()

	tokenA, _, err := svc.Login(ctx, "ops.chan", "correct-horse-1", testMeta)
	require.NoError(t, err)
	_, _, err = svc.Login(ctx, "ops.chan", "correct-horse-1", testMeta)
	require.NoError(t, err)
	require.NoError(t, svc.Logout(ctx, tokenA))

	clock.Advance(7*24*time.Hour + 9*time.Hour)
	_, _, err = svc.Login(ctx, "ops.chan", "correct-horse-1", testMeta)
	require.NoError(t, err)

	deleted, err := svc.DeleteExpiredSessions(ctx, 7*24*time.Hour)
	require.NoError(t, err)
	assert.Equal(t, int64(2), deleted, "revoked A and idle-expired B")
	assert.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM sessions`))
}
```

- [ ] **Step 12: 运行测试，确认失败**

Run: `cd api && go test ./internal/iam/ -run 'TestCreateStaff|TestLogin|TestAuthenticate|TestLogout|TestDeleteExpired'`
Expected: FAIL，编译错误 `undefined: Service`、`undefined: NewService`、`undefined: Staff`、`undefined: IdleTimeout`。

- [ ] **Step 13: 实现会话服务**

`api/internal/iam/service.go`：

```go
package iam

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/netip"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"werun/api/internal/audit"
	"werun/api/internal/iam/store"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/httpx"
)

// 会话参数取自 spec §5.4。
const (
	CookieName      = "werun_admin_session"
	CookiePath      = "/api/admin"
	IdleTimeout     = 8 * time.Hour
	AbsoluteTimeout = 7 * 24 * time.Hour
	TouchInterval   = time.Minute

	tokenBytes     = 32
	minPasswordLen = 10
	maxFullNameLen = 100
	statusActive   = "ACTIVE"
)

var usernamePattern = regexp.MustCompile(`^[a-z0-9._-]{3,64}$`)

func init() {
	apperr.RegisterConstraint("staff_username_key", func() *apperr.Error {
		return apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation).
			WithField("username", "field.invalid", nil)
	})
}

// Staff 是已认证的后台员工。
type Staff struct {
	ID       int64
	Username string
	FullName string
	Role     Role
}

// Service 负责员工账号、登录与会话。
type Service struct {
	pool    *pgxpool.Pool
	q       *store.Queries
	secret  []byte
	limiter *LoginLimiter
	clock   Clock
}

func NewService(pool *pgxpool.Pool, sessionSecret []byte, limiter *LoginLimiter, clock Clock) *Service {
	return &Service{
		pool:    pool,
		q:       store.New(pool),
		secret:  sessionSecret,
		limiter: limiter,
		clock:   clock,
	}
}

// CreateStaff 校验输入并创建员工；用户名重复时返回字段 username 的校验错误。
func (s *Service) CreateStaff(ctx context.Context, username, fullName string, role Role, password string) (Staff, error) {
	username = strings.TrimSpace(username)
	fullName = strings.TrimSpace(fullName)

	verr := apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation)
	invalid := false
	if !usernamePattern.MatchString(username) {
		verr, invalid = verr.WithField("username", "field.invalid", nil), true
	}
	switch {
	case fullName == "":
		verr, invalid = verr.WithField("fullName", "field.required", nil), true
	case utf8.RuneCountInString(fullName) > maxFullNameLen:
		verr, invalid = verr.WithField("fullName", "field.too_long", map[string]any{"max": maxFullNameLen}), true
	}
	if _, ok := ParseRole(string(role)); !ok {
		verr, invalid = verr.WithField("role", "field.invalid", nil), true
	}
	if utf8.RuneCountInString(password) < minPasswordLen {
		verr, invalid = verr.WithField("password", "field.invalid", nil), true
	}
	if invalid {
		return Staff{}, verr
	}

	hash, err := HashPassword(password)
	if err != nil {
		return Staff{}, err
	}
	row, err := s.q.InsertStaff(ctx, store.InsertStaffParams{
		Username:     username,
		FullName:     fullName,
		Role:         string(role),
		PasswordHash: hash,
	})
	if err != nil {
		return Staff{}, apperr.FromPG(err)
	}
	return Staff{ID: row.ID, Username: row.Username, FullName: row.FullName, Role: Role(row.Role)}, nil
}

// Login 校验账号密码并创建会话，返回明文令牌（只出现在 Cookie 里）。
func (s *Service) Login(ctx context.Context, username, password string, meta httpx.Meta) (string, Staff, error) {
	username = strings.ToLower(strings.TrimSpace(username))

	if !s.limiter.AllowIP(meta.IP) {
		return "", Staff{}, apperr.New(http.StatusTooManyRequests, apperr.CodeRateLimited)
	}
	if s.limiter.Locked(username) {
		return "", Staff{}, apperr.New(http.StatusLocked, apperr.CodeAccountLocked)
	}

	row, err := s.q.GetStaffByUsername(ctx, username)
	if errors.Is(err, pgx.ErrNoRows) {
		// 做一次同等开销的哈希，避免通过响应时间判断用户名是否存在。
		_, _ = VerifyPassword(dummyHash(), password)
		s.limiter.Failure(username)
		slog.WarnContext(ctx, "staff login with unknown username",
			"username", username, "ip", meta.IP, "request_id", meta.RequestID)
		return "", Staff{}, invalidCredentials()
	}
	if err != nil {
		return "", Staff{}, fmt.Errorf("iam: load staff %q: %w", username, err)
	}

	staff := Staff{ID: row.ID, Username: row.Username, FullName: row.FullName, Role: Role(row.Role)}
	ok, err := VerifyPassword(row.PasswordHash, password)
	if err != nil {
		return "", Staff{}, fmt.Errorf("iam: verify password of staff %d: %w", row.ID, err)
	}
	if !ok || row.Status != statusActive {
		s.limiter.Failure(username)
		reason := "密码错误"
		if ok {
			reason = "账号已停用"
		}
		err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
			return audit.Record(ctx, tx, audit.Entry{
				ActorType:  "SYSTEM",
				Action:     "staff.login_failed",
				EntityType: "staff",
				EntityID:   staff.ID,
				Summary:    fmt.Sprintf("员工 %s 登录失败：%s", staff.Username, reason),
				Meta:       meta,
			})
		})
		if err != nil {
			return "", Staff{}, err
		}
		return "", Staff{}, invalidCredentials()
	}
	s.limiter.Success(username)

	raw := make([]byte, tokenBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", Staff{}, fmt.Errorf("iam: generate session token: %w", err)
	}
	now := s.clock()
	role := string(staff.Role)
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		if err := q.InsertStaffSession(ctx, store.InsertStaffSessionParams{
			StaffID:   staff.ID,
			TokenHash: s.hashToken(raw),
			ExpiresAt: now.Add(IdleTimeout),
			Ip:        parseIP(meta.IP),
			UserAgent: optionalString(meta.UserAgent),
			CreatedAt: now,
		}); err != nil {
			return err
		}
		if err := q.SetStaffLastLogin(ctx, store.SetStaffLastLoginParams{LastLoginAt: &now, ID: staff.ID}); err != nil {
			return err
		}
		return audit.Record(ctx, tx, audit.Entry{
			ActorType:  "STAFF",
			ActorID:    &staff.ID,
			ActorRole:  &role,
			Action:     "staff.login",
			EntityType: "staff",
			EntityID:   staff.ID,
			Summary:    fmt.Sprintf("员工 %s 登录", staff.Username),
			Meta:       meta,
		})
	})
	if err != nil {
		return "", Staff{}, fmt.Errorf("iam: create session for staff %d: %w", staff.ID, err)
	}
	return base64.RawURLEncoding.EncodeToString(raw), staff, nil
}

// Authenticate 校验令牌；有效时按需滑动续期。
func (s *Service) Authenticate(ctx context.Context, token string) (Staff, error) {
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(raw) != tokenBytes {
		return Staff{}, unauthenticated()
	}
	row, err := s.q.GetStaffSession(ctx, s.hashToken(raw))
	if errors.Is(err, pgx.ErrNoRows) {
		return Staff{}, unauthenticated()
	}
	if err != nil {
		return Staff{}, fmt.Errorf("iam: load session: %w", err)
	}

	now := s.clock()
	absolute := row.CreatedAt.Add(AbsoluteTimeout)
	if row.RevokedAt != nil || !now.Before(row.ExpiresAt) || !now.Before(absolute) || row.Status != statusActive {
		return Staff{}, unauthenticated()
	}

	target := now.Add(IdleTimeout)
	if absolute.Before(target) {
		target = absolute
	}
	if target.Sub(row.ExpiresAt) >= TouchInterval {
		if err := s.q.UpdateSessionExpiry(ctx, store.UpdateSessionExpiryParams{ExpiresAt: target, ID: row.SessionID}); err != nil {
			return Staff{}, fmt.Errorf("iam: extend session %d: %w", row.SessionID, err)
		}
	}

	role, ok := ParseRole(row.Role)
	if !ok {
		return Staff{}, fmt.Errorf("iam: staff %d has unknown role %q", row.StaffID, row.Role)
	}
	return Staff{ID: row.StaffID, Username: row.Username, FullName: row.FullName, Role: role}, nil
}

// Logout 吊销令牌对应的会话；令牌格式不对时什么也不做。
func (s *Service) Logout(ctx context.Context, token string) error {
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(raw) != tokenBytes {
		return nil
	}
	now := s.clock()
	if err := s.q.RevokeSession(ctx, store.RevokeSessionParams{RevokedAt: &now, TokenHash: s.hashToken(raw)}); err != nil {
		return fmt.Errorf("iam: revoke session: %w", err)
	}
	return nil
}

// DeleteExpiredSessions 删除过期或吊销时间早于 now-olderThan 的会话。
func (s *Service) DeleteExpiredSessions(ctx context.Context, olderThan time.Duration) (int64, error) {
	n, err := s.q.DeleteExpiredSessions(ctx, s.clock().Add(-olderThan))
	if err != nil {
		return 0, fmt.Errorf("iam: delete expired sessions: %w", err)
	}
	return n, nil
}

func (s *Service) hashToken(raw []byte) []byte {
	mac := hmac.New(sha256.New, s.secret)
	_, _ = mac.Write(raw)
	return mac.Sum(nil)
}

func invalidCredentials() *apperr.Error {
	return apperr.New(http.StatusUnauthorized, apperr.CodeInvalidCredentials)
}

func unauthenticated() *apperr.Error {
	return apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
}

func parseIP(s string) *netip.Addr {
	addr, err := netip.ParseAddr(s)
	if err != nil {
		return nil
	}
	return &addr
}

func optionalString(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

var (
	dummyHashOnce  sync.Once
	dummyHashValue string
)

func dummyHash() string {
	dummyHashOnce.Do(func() {
		dummyHashValue, _ = HashPassword("werun-dummy-password")
	})
	return dummyHashValue
}
```

- [ ] **Step 14: 运行测试，确认通过**

Run: `cd api && go test ./internal/iam/ ./internal/audit/`（需要本机 Docker）
Expected: `ok  	werun/api/internal/iam`、`ok  	werun/api/internal/audit`。`TestLoginRateLimitedByIP` 会做 21 次 argon2 计算，耗时约 2–3 秒属正常。

- [ ] **Step 15: 全量测试、生成检查与 lint**

Run:

```bash
make gen-api && git status --porcelain api/internal
make test-api && make lint-api
```

Expected：`git status` 只显示本任务新增的文件（重复生成不产生额外改动）；测试全部通过；lint `0 issues.`

- [ ] **Step 16: 提交**

```bash
git add Makefile api/sqlc.yaml api/db/queries/iam.sql api/internal/iam api/internal/audit
git commit -F - <<'EOF'
feat(iam): add staff login service with sessions, rate limiting and audit

- sqlc queries for staff and sessions
- audit.Record writes audit_logs inside the caller's transaction
- in-memory login limiter (20/min per IP, lock after 5 failures)
- sliding 8h idle / 7d absolute sessions with HMAC-hashed tokens

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
```

---

### Task 8: 后台登录接口、认证中间件与 create-staff 命令

**Files:**
- Modify（整体替换）: `api/openapi/openapi.yaml`
- Modify（重新生成）: `api/internal/httpapi/apigen/api.gen.go`、`permissions.gen.go`
- Create: `api/internal/iam/context.go`
- Create: `api/internal/iam/handlers.go`
- Create: `api/internal/httpapi/auth.go`
- Test: `api/internal/httpapi/auth_test.go`
- Modify（整体替换）: `api/internal/httpapi/server.go`
- Modify（整体替换）: `api/internal/httpapi/router.go`
- Create: `api/cmd/werun/createstaff.go`
- Test: `api/cmd/werun/createstaff_test.go`
- Modify: `api/cmd/werun/app.go`（App 增加 IAM）
- Modify: `api/cmd/werun/serve.go`（RouterDeps 增加 IAM、Env）
- Modify: `api/cmd/werun/main.go`（子命令分发增加 create-staff）
- Modify: `Makefile`（新增 `create-staff`）
- Modify: `api/go.mod`、`api/go.sum`（`golang.org/x/term v0.46.0`）

**Interfaces:**
- Consumes：
  - Task 5：`apigen.*`（重新生成后新增 `AdminLoginRequestObject{Body *AdminLoginJSONRequestBody}`、`AdminLogin200JSONResponse`、`AdminLogout204Response`、`AdminGetMe200JSONResponse`、`apigen.Me{Permissions map[string]Access; Staff Staff}`、`apigen.Staff{Id int64; Username; FullName; Role Role}`、`apigen.RoleOPS`、`apigen.AccessWrite`）；`httpapi.NewHealthHandlers`、`httpapi.RouterDeps`、`httpapi.NewRouter`
  - Task 6：`iam.Allowed`、`iam.PermissionsOf`、`iam.Permission`、`iam.Access`、`iam.AllPermissions`、`iam.ParseRole`、`iam.AllRoles`
  - Task 7：`iam.Service`、`iam.NewService`、`iam.NewLoginLimiter`、`(*Service).Login/Authenticate/Logout/CreateStaff`、`iam.CookieName`、`iam.CookiePath`、`iam.AbsoluteTimeout`
  - C5：`httpx.MetaOf(ctx) Meta`、`httpx.Gin(ctx) (*gin.Context, bool)`、`httpx.HeaderClient`、`httpx.WriteError`
  - C3/C4：`apperr.New`、`apperr.As`、`apperr.CodeCSRF|CodeForbidden|CodeUnauthenticated|CodeBadRequest|CodeInvalidCredentials`；`(*i18n.Catalog).T`、`i18n.ZH`
  - Task 4：`main.App`、`main.Bootstrap(ctx) (*App, error)`、`(*App).Close()`
- Produces：
  - `iam.WithStaff(c *gin.Context, s Staff)`、`iam.StaffFrom(ctx context.Context) (Staff, bool)`（C9）
  - `iam.Handlers`、`iam.NewHandlers(svc *Service, secureCookie bool) *Handlers`
  - `httpapi.IAMHandlers`（`= iam.Handlers` 的别名）、`httpapi.CSRFGuard(cat *i18n.Catalog, log *slog.Logger) gin.HandlerFunc`、`httpapi.AuthMiddleware(svc *iam.Service, auths map[string]apigen.OperationAuth) apigen.StrictMiddlewareFunc`
  - `httpapi.RouterDeps` 新增 `IAM *iam.Service`、`Env string`；`httpapi.Server` 新增嵌入 `*IAMHandlers`
  - `main.App.IAM *iam.Service`；`werun create-staff --username --full-name --role [--password-stdin]`；`make create-staff ARGS="..."`

**两处设计说明：**
- **CSRF 头检查放在 gin 中间件 `CSRFGuard` 里**，按路径前缀 `/api/admin/` 判断，而不是放在 strict 中间件里。原因：Global Constraints 要求登录接口（`x-auth: none`）也必须带 `X-WeRun-Client: admin`，而 `OperationAuths` 不区分"公开接口"和"后台的免登录接口"。
- **`Server` 用类型别名嵌入模块 handler**。`iam.Handlers` 与 Task 10 的 `event.Handlers` 类型名相同，直接嵌入会出现同名字段、编译失败。所以在 `server.go` 声明 `type IAMHandlers = iam.Handlers`，嵌入 `*IAMHandlers`；Task 10 同样声明 `type EventHandlers = event.Handlers`。

- [ ] **Step 1: 添加终端输入依赖**

```bash
cd api && go get golang.org/x/term@v0.46.0
```

Expected：`go.mod` 出现 `golang.org/x/term v0.46.0`。

- [ ] **Step 2: 在 OpenAPI 中加入后台认证接口**

用下面内容整体替换 `api/openapi/openapi.yaml`：

```yaml
openapi: 3.0.3
info:
  title: WeRun API
  version: 0.1.0
servers:
  - url: /api
paths:
  /healthz:
    get:
      operationId: getHealthz
      tags: [system]
      summary: 进程存活检查
      responses:
        "200":
          description: 进程存活
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Health"
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
  /readyz:
    get:
      operationId: getReadyz
      tags: [system]
      summary: 数据库连通检查
      responses:
        "200":
          description: 可以接收流量
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Health"
        "503":
          description: 数据库不可用
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Health"
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
  /admin/auth/login:
    post:
      operationId: adminLogin
      tags: [admin-auth]
      summary: 员工登录
      x-auth: none
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/LoginRequest"
      responses:
        "200":
          description: 登录成功，响应头 Set-Cookie 下发 werun_admin_session
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Me"
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
  /admin/auth/logout:
    post:
      operationId: adminLogout
      tags: [admin-auth]
      summary: 退出登录
      x-auth: session
      responses:
        "204":
          description: 已退出
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
  /admin/me:
    get:
      operationId: adminGetMe
      tags: [admin-auth]
      summary: 当前员工与权限
      x-auth: session
      responses:
        "200":
          description: 当前员工
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Me"
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
components:
  schemas:
    ErrorResponse:
      type: object
      required: [error]
      properties:
        error:
          type: object
          required: [code, message]
          properties:
            code:
              type: string
            message:
              type: string
            fields:
              type: object
              additionalProperties:
                type: string
    Health:
      type: object
      required: [status]
      properties:
        status:
          type: string
    Role:
      type: string
      enum: [ADMIN, OPS, FINANCE, SUPPORT, RACE_SUPERVISOR, RACE_STAFF, PHOTOGRAPHER]
    Access:
      type: string
      enum: [read, write]
    Staff:
      type: object
      required: [id, username, fullName, role]
      properties:
        id:
          type: integer
          format: int64
        username:
          type: string
        fullName:
          type: string
        role:
          $ref: "#/components/schemas/Role"
    Me:
      type: object
      required: [staff, permissions]
      properties:
        staff:
          $ref: "#/components/schemas/Staff"
        permissions:
          type: object
          additionalProperties:
            $ref: "#/components/schemas/Access"
    LoginRequest:
      type: object
      required: [username, password]
      properties:
        username:
          type: string
          minLength: 1
          maxLength: 64
        password:
          type: string
          minLength: 1
          maxLength: 256
```

- [ ] **Step 3: 重新生成，确认 Server 缺少新方法（失败）**

Run: `make gen-api && cd api && go build ./...`
Expected: FAIL，类似：

```
internal/httpapi/server.go: cannot use (*Server)(nil) (value of type *Server) as apigen.StrictServerInterface value in variable declaration: *Server does not implement apigen.StrictServerInterface (missing method AdminGetMe)
```

`api/internal/httpapi/apigen/permissions.gen.go` 的映射应变为：

```go
var OperationAuths = map[string]OperationAuth{
	"AdminGetMe":  {Kind: AuthSession},
	"AdminLogin":  {Kind: AuthNone},
	"AdminLogout": {Kind: AuthSession},
	"GetHealthz":  {Kind: AuthNone},
	"GetReadyz":   {Kind: AuthNone},
}
```

- [ ] **Step 4: 写认证接口的失败测试**

`api/internal/httpapi/auth_test.go`：

```go
package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/platform/logx"
)

const authTestSecret = "0123456789abcdef0123456789abcdef"

type authFixture struct {
	router *gin.Engine
	svc    *iam.Service
	cat    *i18n.Catalog
}

func newAuthFixture(t *testing.T) authFixture {
	t.Helper()
	pool := dbtest.NewPool(t)
	cat, err := i18n.LoadCatalog()
	require.NoError(t, err)
	svc := iam.NewService(pool, []byte(authTestSecret), iam.NewLoginLimiter(time.Now), time.Now)
	_, err = svc.CreateStaff(context.Background(), "ops.chan", "Chanthou Ny", iam.RoleOps, "correct-horse-1")
	require.NoError(t, err)
	router := NewRouter(RouterDeps{
		Log:     logx.New("error", io.Discard),
		Catalog: cat,
		Pool:    pool,
		IAM:     svc,
		Env:     "dev",
	})
	return authFixture{router: router, svc: svc, cat: cat}
}

type request struct {
	method   string
	target   string
	body     string
	asClient bool
	cookie   *http.Cookie
}

func (f authFixture) do(r request) *httptest.ResponseRecorder {
	var body io.Reader
	if r.body != "" {
		body = strings.NewReader(r.body)
	}
	req := httptest.NewRequest(r.method, r.target, body)
	if r.body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if r.asClient {
		req.Header.Set(httpx.HeaderClient, "admin")
	}
	if r.cookie != nil {
		req.AddCookie(r.cookie)
	}
	rec := httptest.NewRecorder()
	f.router.ServeHTTP(rec, req)
	return rec
}

func sessionCookie(t *testing.T, rec *httptest.ResponseRecorder) *http.Cookie {
	t.Helper()
	for _, c := range rec.Result().Cookies() {
		if c.Name == iam.CookieName {
			return c
		}
	}
	t.Fatalf("response has no %s cookie", iam.CookieName)
	return nil
}

func decodeError(t *testing.T, rec *httptest.ResponseRecorder) apigen.ErrorResponse {
	t.Helper()
	var body apigen.ErrorResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body), rec.Body.String())
	return body
}

func (f authFixture) login(t *testing.T) *http.Cookie {
	t.Helper()
	rec := f.do(request{
		method:   http.MethodPost,
		target:   "/api/admin/auth/login",
		body:     `{"username":"ops.chan","password":"correct-horse-1"}`,
		asClient: true,
	})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	return sessionCookie(t, rec)
}

func TestAdminLoginSetsSessionCookie(t *testing.T) {
	f := newAuthFixture(t)
	rec := f.do(request{
		method:   http.MethodPost,
		target:   "/api/admin/auth/login",
		body:     `{"username":"ops.chan","password":"correct-horse-1"}`,
		asClient: true,
	})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	cookie := sessionCookie(t, rec)
	assert.NotEmpty(t, cookie.Value)
	assert.Equal(t, "/api/admin", cookie.Path)
	assert.True(t, cookie.HttpOnly)
	assert.False(t, cookie.Secure, "dev environment")
	assert.Equal(t, http.SameSiteLaxMode, cookie.SameSite)

	var me apigen.Me
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &me))
	assert.Equal(t, "ops.chan", me.Staff.Username)
	assert.Equal(t, apigen.RoleOPS, me.Staff.Role)
	assert.Equal(t, apigen.AccessWrite, me.Permissions["event_config"])
	assert.Equal(t, apigen.AccessWrite, me.Permissions["event_publish"])
}

func TestAdminLoginWrongPasswordIsLocalized(t *testing.T) {
	f := newAuthFixture(t)
	rec := f.do(request{
		method:   http.MethodPost,
		target:   "/api/admin/auth/login?lang=zh",
		body:     `{"username":"ops.chan","password":"wrong-password"}`,
		asClient: true,
	})
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	body := decodeError(t, rec)
	assert.Equal(t, apperr.CodeInvalidCredentials, body.Error.Code)
	assert.Equal(t, f.cat.T(i18n.ZH, apperr.CodeInvalidCredentials, nil), body.Error.Message)
}

func TestAdminLoginRequiresClientHeader(t *testing.T) {
	f := newAuthFixture(t)
	rec := f.do(request{
		method: http.MethodPost,
		target: "/api/admin/auth/login",
		body:   `{"username":"ops.chan","password":"correct-horse-1"}`,
	})
	assert.Equal(t, http.StatusForbidden, rec.Code)
	assert.Equal(t, apperr.CodeCSRF, decodeError(t, rec).Error.Code)
}

func TestAdminMeRequiresSession(t *testing.T) {
	f := newAuthFixture(t)
	rec := f.do(request{method: http.MethodGet, target: "/api/admin/me?lang=zh"})

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	body := decodeError(t, rec)
	assert.Equal(t, apperr.CodeUnauthenticated, body.Error.Code)
	assert.Equal(t, f.cat.T(i18n.ZH, apperr.CodeUnauthenticated, nil), body.Error.Message)
}

func TestAdminMeWithSession(t *testing.T) {
	f := newAuthFixture(t)
	rec := f.do(request{method: http.MethodGet, target: "/api/admin/me", cookie: f.login(t)})

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var me apigen.Me
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &me))
	assert.Equal(t, "Chanthou Ny", me.Staff.FullName)
	assert.Equal(t, apigen.AccessWrite, me.Permissions["event_config"])
}

func TestAdminLogoutRequiresClientHeader(t *testing.T) {
	f := newAuthFixture(t)
	rec := f.do(request{method: http.MethodPost, target: "/api/admin/auth/logout", cookie: f.login(t)})

	assert.Equal(t, http.StatusForbidden, rec.Code)
	assert.Equal(t, apperr.CodeCSRF, decodeError(t, rec).Error.Code)
}

func TestAdminLogoutRevokesSession(t *testing.T) {
	f := newAuthFixture(t)
	cookie := f.login(t)

	rec := f.do(request{method: http.MethodPost, target: "/api/admin/auth/logout", asClient: true, cookie: cookie})
	require.Equal(t, http.StatusNoContent, rec.Code, rec.Body.String())
	assert.Less(t, sessionCookie(t, rec).MaxAge, 0, "cookie cleared")

	rec = f.do(request{method: http.MethodGet, target: "/api/admin/me", cookie: cookie})
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestAuthMiddlewarePermissions(t *testing.T) {
	f := newAuthFixture(t)
	ctx := context.Background()
	_, err := f.svc.CreateStaff(ctx, "photog.sok", "Sokha Ith", iam.RolePhotographer, "correct-horse-1")
	require.NoError(t, err)
	meta := httpx.Meta{IP: "198.51.100.10"}
	opsToken, _, err := f.svc.Login(ctx, "ops.chan", "correct-horse-1", meta)
	require.NoError(t, err)
	photogToken, _, err := f.svc.Login(ctx, "photog.sok", "correct-horse-1", meta)
	require.NoError(t, err)

	auths := map[string]apigen.OperationAuth{
		"FakeWrite": {Kind: apigen.AuthPermission, Permission: string(iam.PermEventConfig), Access: string(iam.AccessWrite)},
	}
	mw := AuthMiddleware(f.svc, auths)
	next := func(c *gin.Context, _ any) (any, error) {
		staff, ok := iam.StaffFrom(c)
		require.True(t, ok)
		return staff.Username, nil
	}
	call := func(operationID, token string) (any, error) {
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest(http.MethodGet, "/api/admin/fake", nil)
		if token != "" {
			c.Request.AddCookie(&http.Cookie{Name: iam.CookieName, Value: token})
		}
		return mw(next, operationID)(c, nil)
	}

	got, err := call("FakeWrite", opsToken)
	require.NoError(t, err)
	assert.Equal(t, "ops.chan", got)

	_, err = call("FakeWrite", photogToken)
	appErr, ok := apperr.As(err)
	require.True(t, ok)
	assert.Equal(t, apperr.CodeForbidden, appErr.Code)

	_, err = call("FakeWrite", "")
	appErr, ok = apperr.As(err)
	require.True(t, ok)
	assert.Equal(t, apperr.CodeUnauthenticated, appErr.Code)

	_, err = call("NotInMap", opsToken)
	appErr, ok = apperr.As(err)
	require.True(t, ok)
	assert.Equal(t, apperr.CodeForbidden, appErr.Code)
}

func TestOperationAuthsUseKnownPermissions(t *testing.T) {
	known := map[string]bool{}
	for _, p := range iam.AllPermissions {
		known[string(p)] = true
	}
	for op, rule := range apigen.OperationAuths {
		if rule.Kind != apigen.AuthPermission {
			continue
		}
		assert.True(t, known[rule.Permission], "%s uses unknown permission %q", op, rule.Permission)
		assert.Contains(t, []string{string(iam.AccessRead), string(iam.AccessWrite)}, rule.Access, op)
	}
}
```

`api/cmd/werun/createstaff_test.go`：

```go
package main

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/iam"
)

func TestReadPasswordLine(t *testing.T) {
	for input, want := range map[string]string{
		"correct-horse-1\n":   "correct-horse-1",
		"correct-horse-1\r\n": "correct-horse-1",
		"correct-horse-1":     "correct-horse-1",
		"first\nsecond\n":     "first",
	} {
		got, err := readPasswordLine(strings.NewReader(input))
		require.NoError(t, err, input)
		assert.Equal(t, want, got, input)
	}
}

func TestReadPasswordLineEmpty(t *testing.T) {
	for _, input := range []string{"", "\n", "\r\n"} {
		_, err := readPasswordLine(strings.NewReader(input))
		assert.Error(t, err, "%q", input)
	}
}

func TestRoleListContainsAllRoles(t *testing.T) {
	list := roleList()
	for _, r := range iam.AllRoles {
		assert.Contains(t, list, string(r))
	}
}
```

- [ ] **Step 5: 运行测试，确认失败**

Run: `cd api && go test ./internal/httpapi/ ./cmd/werun/`
Expected: FAIL，编译错误 `missing method AdminGetMe`、`undefined: AuthMiddleware`、`unknown field IAM in struct literal of type RouterDeps`、`undefined: iam.StaffFrom`、`undefined: readPasswordLine`、`undefined: roleList`。

- [ ] **Step 6: 实现员工上下文与 handler**

`api/internal/iam/context.go`：

```go
package iam

import (
	"context"

	"github.com/gin-gonic/gin"
)

// staffContextKey 是 gin 上下文键；gin.Context.Value 对字符串键会查 c.Get。
const staffContextKey = "werun.staff"

// WithStaff 由认证中间件调用，把当前员工放进请求上下文。
func WithStaff(c *gin.Context, s Staff) {
	c.Set(staffContextKey, s)
}

// StaffFrom 取出当前员工；ctx 为 *gin.Context 或其派生。
func StaffFrom(ctx context.Context) (Staff, bool) {
	if ctx == nil {
		return Staff{}, false
	}
	s, ok := ctx.Value(staffContextKey).(Staff)
	return s, ok
}
```

`api/internal/iam/handlers.go`：

```go
package iam

import (
	"context"
	"net/http"

	"github.com/gin-gonic/gin"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
)

// Handlers 实现 adminLogin / adminLogout / adminGetMe。
type Handlers struct {
	svc          *Service
	secureCookie bool
}

// NewHandlers：secureCookie 在 WERUN_ENV=prod 时为 true。
func NewHandlers(svc *Service, secureCookie bool) *Handlers {
	return &Handlers{svc: svc, secureCookie: secureCookie}
}

func (h *Handlers) AdminLogin(ctx context.Context, req apigen.AdminLoginRequestObject) (apigen.AdminLoginResponseObject, error) {
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	token, staff, err := h.svc.Login(ctx, req.Body.Username, req.Body.Password, httpx.MetaOf(ctx))
	if err != nil {
		return nil, err
	}
	if c, ok := httpx.Gin(ctx); ok {
		h.setSessionCookie(c, token, int(AbsoluteTimeout.Seconds()))
	}
	return apigen.AdminLogin200JSONResponse(toMe(staff)), nil
}

func (h *Handlers) AdminLogout(ctx context.Context, _ apigen.AdminLogoutRequestObject) (apigen.AdminLogoutResponseObject, error) {
	if c, ok := httpx.Gin(ctx); ok {
		if token, err := c.Cookie(CookieName); err == nil && token != "" {
			if err := h.svc.Logout(ctx, token); err != nil {
				return nil, err
			}
		}
		h.setSessionCookie(c, "", -1)
	}
	return apigen.AdminLogout204Response{}, nil
}

func (h *Handlers) AdminGetMe(ctx context.Context, _ apigen.AdminGetMeRequestObject) (apigen.AdminGetMeResponseObject, error) {
	staff, ok := StaffFrom(ctx)
	if !ok {
		return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	return apigen.AdminGetMe200JSONResponse(toMe(staff)), nil
}

func (h *Handlers) setSessionCookie(c *gin.Context, value string, maxAge int) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     CookieName,
		Value:    value,
		Path:     CookiePath,
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   h.secureCookie,
		SameSite: http.SameSiteLaxMode,
	})
}

func toMe(s Staff) apigen.Me {
	perms := make(map[string]apigen.Access)
	for p, a := range PermissionsOf(s.Role) {
		perms[string(p)] = apigen.Access(a)
	}
	return apigen.Me{
		Staff: apigen.Staff{
			Id:       s.ID,
			Username: s.Username,
			FullName: s.FullName,
			Role:     apigen.Role(s.Role),
		},
		Permissions: perms,
	}
}
```

- [ ] **Step 7: 实现认证中间件，更新 Server 与路由**

`api/internal/httpapi/auth.go`：

```go
package httpapi

import (
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
)

const adminPathPrefix = "/api/admin/"

// CSRFGuard：/api/admin/ 下除 GET、HEAD 外的请求必须带 X-WeRun-Client: admin（含登录接口）。
func CSRFGuard(cat *i18n.Catalog, log *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		method := c.Request.Method
		if strings.HasPrefix(c.Request.URL.Path, adminPathPrefix) &&
			method != http.MethodGet && method != http.MethodHead &&
			c.GetHeader(httpx.HeaderClient) != "admin" {
			httpx.WriteError(c, cat, log, apperr.New(http.StatusForbidden, apperr.CodeCSRF))
			c.Abort()
			return
		}
		c.Next()
	}
}

// AuthMiddleware 按 apigen.OperationAuths 做会话认证与权限校验。
// 映射表里查不到的接口一律拒绝（说明忘了执行 make gen-api）。
func AuthMiddleware(svc *iam.Service, auths map[string]apigen.OperationAuth) apigen.StrictMiddlewareFunc {
	return func(next apigen.StrictHandlerFunc, operationID string) apigen.StrictHandlerFunc {
		rule, known := auths[operationID]
		if known && rule.Kind == apigen.AuthNone {
			return next
		}
		return func(c *gin.Context, request any) (any, error) {
			if !known {
				return nil, apperr.New(http.StatusForbidden, apperr.CodeForbidden).
					Wrap(fmt.Errorf("operation %s is missing from OperationAuths; run make gen-api", operationID))
			}
			token, err := c.Cookie(iam.CookieName)
			if err != nil || token == "" {
				return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
			}
			staff, err := svc.Authenticate(c, token)
			if err != nil {
				return nil, err
			}
			iam.WithStaff(c, staff)
			if rule.Kind == apigen.AuthPermission &&
				!iam.Allowed(staff.Role, iam.Permission(rule.Permission), iam.Access(rule.Access)) {
				return nil, apperr.New(http.StatusForbidden, apperr.CodeForbidden)
			}
			return next(c, request)
		}
	}
}
```

用下面内容整体替换 `api/internal/httpapi/server.go`：

```go
package httpapi

import (
	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
)

// 各模块的 handler 类型都叫 Handlers，直接嵌入会出现同名字段；
// 用别名嵌入，字段名即别名（IAMHandlers、EventHandlers……）。
type IAMHandlers = iam.Handlers

// Server 组合各模块的 handler，实现 apigen.StrictServerInterface。
// 新增模块时在这里嵌入该模块的 handler，并在 NewServer 中构造。
type Server struct {
	*HealthHandlers
	*IAMHandlers
}

var _ apigen.StrictServerInterface = (*Server)(nil)

// NewServer 用路由依赖构造全部模块 handler。
func NewServer(d RouterDeps) *Server {
	return &Server{
		HealthHandlers: NewHealthHandlers(d.Pool),
		IAMHandlers:    iam.NewHandlers(d.IAM, d.Env == "prod"),
	}
}
```

用下面内容整体替换 `api/internal/httpapi/router.go`：

```go
package httpapi

import (
	"log/slog"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
)

// RouterDeps 是构造 HTTP 路由所需的依赖。
type RouterDeps struct {
	Log     *slog.Logger
	Catalog *i18n.Catalog
	Pool    *pgxpool.Pool
	IAM     *iam.Service
	Server  *Server // 为 nil 时由 NewServer 构造
	Env     string  // "dev" | "prod"
}

// trustedProxies：只信任本机与私有网段（compose 网络里的 Caddy）转发的 X-Forwarded-For，
// 这样 c.ClientIP() 才是真实客户端 IP，登录限流按人计算。以后在 Caddy 前面加 Cloudflare 时，由 Caddy 的 trusted_proxies 处理。
var trustedProxies = []string{"127.0.0.1/32", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"}

// NewRouter 组装中间件与 apigen 生成的路由，所有接口挂在 /api 下。
func NewRouter(d RouterDeps) *gin.Engine {
	engine := gin.New()
	if err := engine.SetTrustedProxies(trustedProxies); err != nil {
		panic(err) // 列表是常量，出错说明代码写错了
	}
	engine.Use(
		httpx.RequestID(),
		httpx.AccessLog(d.Log),
		httpx.Recover(d.Catalog, d.Log),
		httpx.Locale(),
		CSRFGuard(d.Catalog, d.Log),
	)

	server := d.Server
	if server == nil {
		server = NewServer(d)
	}

	writeErr := func(c *gin.Context, err error) {
		httpx.WriteError(c, d.Catalog, d.Log, err)
	}
	middlewares := []apigen.StrictMiddlewareFunc{
		AuthMiddleware(d.IAM, apigen.OperationAuths),
	}
	strict := apigen.NewStrictHandlerWithOptions(server, middlewares, apigen.StrictGinServerOptions{
		RequestErrorHandlerFunc: func(c *gin.Context, err error) {
			writeErr(c, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest).Wrap(err))
		},
		HandlerErrorFunc:         writeErr,
		ResponseErrorHandlerFunc: writeErr,
	})
	apigen.RegisterHandlersWithOptions(engine, strict, apigen.GinServerOptions{
		BaseURL: "/api",
		ErrorHandler: func(c *gin.Context, err error, status int) {
			writeErr(c, apperr.New(status, apperr.CodeBadRequest).Wrap(err))
		},
	})
	// 保留 Task 4 的行为：未知路径返回按语言翻译的 NOT_FOUND
	engine.NoRoute(func(c *gin.Context) {
		writeErr(c, apperr.New(http.StatusNotFound, apperr.CodeNotFound))
	})
	return engine
}
```

- [ ] **Step 8: 接入命令行（App、serve、create-staff）**

在 `api/cmd/werun/app.go` 中（Task 4 的 `Bootstrap` 末尾是 `return &App{Cfg: cfg, Log: log, Catalog: cat, Pool: pool}, nil`）：

1. `App` 结构体增加字段 `IAM *iam.Service`，import 加入 `"log/slog"`（若已有则跳过）、`"time"`、`"werun/api/internal/iam"`。
2. 在 `log := logx.New(cfg.LogLevel, os.Stdout)` 这一行之后加入 `slog.SetDefault(log)`（`Service.Login` 的"未知用户名"警告写默认 logger）。
3. 把 `Bootstrap` 最后的 `return &App{...}, nil` 替换为：

```go
	app := &App{Cfg: cfg, Log: log, Catalog: cat, Pool: pool}
	app.IAM = iam.NewService(app.Pool, []byte(app.Cfg.SessionSecret), iam.NewLoginLimiter(time.Now), time.Now)
	return app, nil
```

在 `api/cmd/werun/serve.go` 中，把 `http.Server` 字面量的 `Handler:` 字段改为：

```go
		Handler: httpapi.NewRouter(httpapi.RouterDeps{
			Log:     app.Log,
			Catalog: app.Catalog,
			Pool:    app.Pool,
			IAM:     app.IAM,
			Env:     app.Cfg.Env,
		}),
```

在 `api/cmd/werun/main.go` 的 `run` 函数（Task 4 签名 `run(ctx context.Context, args []string, stdout, stderr io.Writer) int`）的 `switch` 中，`case "healthcheck":` 分支之后加入：

```go
	case "create-staff":
		if err := runCreateStaff(ctx, args[1:]); err != nil {
			fmt.Fprintf(stderr, "create-staff: %v\n", err)
			return 1
		}
		return 0
```

并在 `usage` 常量的 `healthcheck` 那一行下面加一行：

```
  create-staff 创建后台员工：--username --full-name --role [--password-stdin]
```

新建 `api/cmd/werun/createstaff.go`：

```go
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"

	"golang.org/x/term"

	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/i18n"
)

// runCreateStaff 实现 `werun create-staff`。
func runCreateStaff(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("create-staff", flag.ContinueOnError)
	username := fs.String("username", "", "登录名：3–64 位小写字母、数字、点、下划线或连字符")
	fullName := fs.String("full-name", "", "员工姓名")
	roleName := fs.String("role", "", "角色："+roleList())
	passwordStdin := fs.Bool("password-stdin", false, "从标准输入读取密码（CI 与脚本使用）")
	if err := fs.Parse(args); err != nil {
		return err
	}
	role, ok := iam.ParseRole(*roleName)
	if !ok {
		return fmt.Errorf("--role 必须是以下之一：%s", roleList())
	}

	var password string
	var err error
	if *passwordStdin {
		password, err = readPasswordLine(os.Stdin)
	} else {
		password, err = promptPassword(os.Stdin, os.Stderr)
	}
	if err != nil {
		return err
	}

	app, err := Bootstrap(ctx)
	if err != nil {
		return err
	}
	defer app.Close()

	staff, err := app.IAM.CreateStaff(ctx, *username, *fullName, role, password)
	if err != nil {
		return describeError(app.Catalog, err)
	}
	fmt.Fprintf(os.Stdout, "已创建员工 id=%d username=%s role=%s\n", staff.ID, staff.Username, staff.Role)
	return nil
}

func roleList() string {
	names := make([]string, len(iam.AllRoles))
	for i, r := range iam.AllRoles {
		names[i] = string(r)
	}
	return strings.Join(names, ", ")
}

// readPasswordLine 读取第一行作为密码，去掉行尾换行。
func readPasswordLine(r io.Reader) (string, error) {
	line, err := bufio.NewReader(r).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", fmt.Errorf("读取密码失败: %w", err)
	}
	password := strings.TrimRight(line, "\r\n")
	if password == "" {
		return "", errors.New("标准输入中没有密码")
	}
	return password, nil
}

// promptPassword 在终端里不回显地输入两次密码。
func promptPassword(in *os.File, out io.Writer) (string, error) {
	fd := int(in.Fd())
	if !term.IsTerminal(fd) {
		return "", errors.New("当前不是交互式终端，请改用 --password-stdin")
	}
	fmt.Fprint(out, "密码: ")
	first, err := term.ReadPassword(fd)
	fmt.Fprintln(out)
	if err != nil {
		return "", err
	}
	fmt.Fprint(out, "再次输入密码: ")
	second, err := term.ReadPassword(fd)
	fmt.Fprintln(out)
	if err != nil {
		return "", err
	}
	if string(first) != string(second) {
		return "", errors.New("两次输入的密码不一致")
	}
	return string(first), nil
}

// describeError 把业务错误渲染成中文提示，列出每个出错字段。
func describeError(cat *i18n.Catalog, err error) error {
	appErr, ok := apperr.As(err)
	if !ok {
		return err
	}
	msg := cat.T(i18n.ZH, appErr.Code, appErr.Params)
	if len(appErr.Fields) == 0 {
		return errors.New(msg)
	}
	fields := make([]string, 0, len(appErr.Fields))
	for name, fe := range appErr.Fields {
		fields = append(fields, fmt.Sprintf("%s: %s", name, cat.T(i18n.ZH, fe.Key, fe.Params)))
	}
	sort.Strings(fields)
	return fmt.Errorf("%s（%s）", msg, strings.Join(fields, "；"))
}
```

在根 `Makefile` 末尾追加（行首是 Tab）：

```make
.PHONY: create-staff

create-staff:
	set -a; . ./.env; set +a; cd api && go run ./cmd/werun create-staff $(ARGS)
```

- [ ] **Step 9: 运行测试，确认通过**

Run: `cd api && go build ./... && go test ./internal/httpapi/... ./internal/iam/... ./cmd/werun/`（需要本机 Docker）
Expected：

```
ok  	werun/api/internal/httpapi
ok  	werun/api/internal/httpapi/cmd/permgen
ok  	werun/api/internal/iam
ok  	werun/api/cmd/werun
```

- [ ] **Step 10: 手工验证登录链路**

在一个终端启动数据库与服务（`.env` 按 Task 1 的 `.env.example` 填好，`WERUN_DATABASE_URL` 指向本地 PostgreSQL）：

```bash
make migrate-up
printf 'correct-horse-1\n' | make create-staff ARGS="--username ops.chan --full-name 'Chanthou Ny' --role OPS --password-stdin"
set -a; . ./.env; set +a; cd api && go run ./cmd/werun serve
```

Expected：create-staff 输出 `已创建员工 id=1 username=ops.chan role=OPS`。

另开一个终端：

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8080/api/admin/auth/login \
  -H 'Content-Type: application/json' -d '{"username":"ops.chan","password":"correct-horse-1"}'
curl -s -c /tmp/werun.cookies -X POST http://127.0.0.1:8080/api/admin/auth/login \
  -H 'X-WeRun-Client: admin' -H 'Content-Type: application/json' \
  -d '{"username":"ops.chan","password":"correct-horse-1"}'
curl -s -b /tmp/werun.cookies 'http://127.0.0.1:8080/api/admin/me?lang=zh'
curl -s 'http://127.0.0.1:8080/api/admin/me?lang=zh'
```

Expected：
1. 第一条（没带 `X-WeRun-Client`）输出 `403`。
2. 第二条返回 `{"permissions":{...,"event_config":"write",...},"staff":{"fullName":"Chanthou Ny","id":1,"role":"OPS","username":"ops.chan"}}`。
3. 第三条返回同样的 Me。
4. 第四条返回 `{"error":{"code":"UNAUTHENTICATED","message":"<中文文案>"}}`。

再次执行同一条 create-staff 命令，Expected：退出码非 0，输出包含 `username:` 字段错误。

- [ ] **Step 11: 全量测试、生成检查与 lint**

Run:

```bash
make gen-api && git status --porcelain api/internal/httpapi/apigen
make test-api && make lint-api
```

Expected：重复生成没有额外改动；测试全部通过；lint `0 issues.`

- [ ] **Step 12: 提交**

```bash
git add Makefile api/go.mod api/go.sum api/openapi/openapi.yaml api/internal/httpapi api/internal/iam api/cmd/werun
git commit -F - <<'EOF'
feat(api): add admin login/logout/me with session auth middleware and create-staff

- CSRFGuard requires X-WeRun-Client: admin on non-GET /api/admin/* requests
- AuthMiddleware enforces x-auth / x-permission rules from OperationAuths
- werun create-staff supports --password-stdin for CI

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
```
