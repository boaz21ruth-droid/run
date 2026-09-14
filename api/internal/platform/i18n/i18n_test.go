package i18n

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestParse(t *testing.T) {
	cases := []struct {
		in   string
		want Lang
		ok   bool
	}{
		{"zh", ZH, true},
		{"EN", EN, true},
		{"km-KH", KM, true},
		{"zh_CN", ZH, true},
		{" en-US ", EN, true},
		{"fr", "", false},
		{"", "", false},
	}
	for _, c := range cases {
		got, ok := Parse(c.in)
		assert.Equal(t, c.ok, ok, "input %q", c.in)
		assert.Equal(t, c.want, got, "input %q", c.in)
	}
}

func TestFromRequest(t *testing.T) {
	assert.Equal(t, ZH, FromRequest("zh", "en-US,en;q=0.9"), "query wins")
	assert.Equal(t, EN, FromRequest("fr", "fr-FR,en;q=0.8,km;q=0.5"), "first supported Accept-Language")
	assert.Equal(t, KM, FromRequest("", "km-KH"))
	assert.Equal(t, Default, FromRequest("", "fr-FR,de"))
	assert.Equal(t, Default, FromRequest("", ""))
	assert.Equal(t, KM, Default)
}

func TestTextIn(t *testing.T) {
	full := Text{ZH: "金边半马", EN: "Phnom Penh Half", KM: "ពាក់កណ្តាលម៉ារ៉ាតុងភ្នំពេញ"}
	assert.Equal(t, "ពាក់កណ្តាលម៉ារ៉ាតុងភ្នំពេញ", full.In(KM))

	noKM := Text{ZH: "金边半马", EN: "Phnom Penh Half"}
	assert.Equal(t, "Phnom Penh Half", noKM.In(KM), "falls back to en")

	zhOnly := Text{ZH: "金边半马", EN: ""}
	assert.Equal(t, "金边半马", zhOnly.In(KM), "falls back to zh when en empty")

	assert.Equal(t, "", Text{}.In(ZH))
}
