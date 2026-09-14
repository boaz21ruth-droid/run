package i18n

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"slices"
	"strings"
)

//go:embed messages.zh.json messages.en.json messages.km.json
var messagesFS embed.FS

// Catalog 是错误文案目录。
type Catalog struct {
	msgs map[Lang]map[string]string
}

// LoadCatalog 读取内置的三语文案；三份文件 key 集合不一致时返回错误。
func LoadCatalog() (*Catalog, error) {
	return loadCatalog(messagesFS)
}

func loadCatalog(fsys fs.FS) (*Catalog, error) {
	c := &Catalog{msgs: make(map[Lang]map[string]string, len(allLangs))}
	union := map[string]struct{}{}
	for _, l := range allLangs {
		data, err := fs.ReadFile(fsys, "messages."+string(l)+".json")
		if err != nil {
			return nil, fmt.Errorf("i18n: read %s messages: %w", l, err)
		}
		m := map[string]string{}
		if err := json.Unmarshal(data, &m); err != nil {
			return nil, fmt.Errorf("i18n: parse %s messages: %w", l, err)
		}
		c.msgs[l] = m
		for k := range m {
			union[k] = struct{}{}
		}
	}

	keys := make([]string, 0, len(union))
	for k := range union {
		keys = append(keys, k)
	}
	slices.Sort(keys)

	var problems []string
	for _, k := range keys {
		for _, l := range allLangs {
			if _, ok := c.msgs[l][k]; !ok {
				problems = append(problems, fmt.Sprintf("%s missing %q", l, k))
			}
		}
	}
	if len(problems) > 0 {
		return nil, fmt.Errorf("i18n: message key sets differ: %s", strings.Join(problems, "; "))
	}
	return c, nil
}

// T 返回文案。依次尝试 l、英文、中文，均无（或为空）时返回 key 本身；
// 文案中的 {name} 会被 params["name"] 替换。
func (c *Catalog) T(l Lang, key string, params map[string]any) string {
	msg := key
	for _, candidate := range []Lang{l, EN, ZH} {
		if v := c.msgs[candidate][key]; v != "" {
			msg = v
			break
		}
	}
	for name, value := range params {
		msg = strings.ReplaceAll(msg, "{"+name+"}", fmt.Sprint(value))
	}
	return msg
}
