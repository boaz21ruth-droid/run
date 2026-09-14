// Package i18n 提供中文、英文、高棉文三语支持：语言解析、多语言文本与错误文案目录。
package i18n

import "strings"

// Lang 是受支持的语言代码。
type Lang string

const (
	ZH      Lang = "zh"
	EN      Lang = "en"
	KM      Lang = "km"
	Default      = KM
)

var allLangs = []Lang{ZH, EN, KM}

// Parse 解析语言代码，大小写不敏感，接受 zh-CN、km_KH 这类带地区的写法。
func Parse(s string) (Lang, bool) {
	s = strings.ToLower(strings.TrimSpace(s))
	if i := strings.IndexAny(s, "-_"); i >= 0 {
		s = s[:i]
	}
	switch l := Lang(s); l {
	case ZH, EN, KM:
		return l, true
	}
	return "", false
}

// FromRequest 按 ?lang= → Accept-Language（按出现顺序取第一个受支持的）→ Default 的顺序确定语言。
func FromRequest(queryLang, acceptLanguage string) Lang {
	if l, ok := Parse(queryLang); ok {
		return l
	}
	for _, part := range strings.Split(acceptLanguage, ",") {
		tag, _, _ := strings.Cut(part, ";")
		if l, ok := Parse(tag); ok {
			return l
		}
	}
	return Default
}

// Text 是一段三语文本，JSON 形如 {"zh":"…","en":"…","km":"…"}。
type Text map[Lang]string

// In 返回指定语言的文本；为空时依次回退到英文、中文，都没有时返回空字符串。
func (t Text) In(l Lang) string {
	for _, candidate := range []Lang{l, EN, ZH} {
		if v := t[candidate]; v != "" {
			return v
		}
	}
	return ""
}
