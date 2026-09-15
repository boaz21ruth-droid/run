package runner_test

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/runner"
)

const initBotToken = "123456:initdata-test-token"

var initNow = time.Date(2026, 9, 14, 3, 0, 0, 0, time.UTC)

func sampleTelegramUser() runner.TelegramUser {
	return runner.TelegramUser{ID: 10001, FirstName: "Dara", LastName: "Sok", Username: "darasok", LanguageCode: "km"}
}

func requireTelegramAuthInvalid(t *testing.T, err error) {
	t.Helper()
	ae, ok := apperr.As(err)
	require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
	assert.Equal(t, apperr.CodeTelegramAuthInvalid, ae.Code)
	assert.Equal(t, http.StatusUnauthorized, ae.Status)
}

// referenceHash 按 Telegram 文档独立实现一遍签名算法，避免 SignInitData 与 VerifyInitData 同时写错却互相通过。
func referenceHash(botToken string, values url.Values) string {
	keys := make([]string, 0, len(values))
	for k := range values {
		if k != "hash" {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	lines := make([]string, 0, len(keys))
	for _, k := range keys {
		lines = append(lines, k+"="+values.Get(k))
	}
	secret := hmac.New(sha256.New, []byte("WebAppData"))
	_, _ = secret.Write([]byte(botToken))
	mac := hmac.New(sha256.New, secret.Sum(nil))
	_, _ = mac.Write([]byte(strings.Join(lines, "\n")))
	return hex.EncodeToString(mac.Sum(nil))
}

func signedValues(t *testing.T, authDate time.Time) url.Values {
	t.Helper()
	values, err := url.ParseQuery(runner.SignInitData(initBotToken, sampleTelegramUser(), authDate))
	require.NoError(t, err)
	return values
}

func TestVerifyInitDataAcceptsDataSignedByTelegramAlgorithm(t *testing.T) {
	values := url.Values{}
	values.Set("query_id", "AAHdF6IQAAAAAN0XohDhrOrc")
	values.Set("user", `{"id":10002,"first_name":"សុខា","last_name":"Chan","username":"sokha_c","language_code":"zh-hans","allows_write_to_pm":true}`)
	values.Set("auth_date", strconv.FormatInt(initNow.Add(-time.Hour).Unix(), 10))
	values.Set("signature", "ZmFrZS1zaWduYXR1cmU")
	values.Set("hash", referenceHash(initBotToken, values))

	got, err := runner.VerifyInitData(values.Encode(), initBotToken, initNow)

	require.NoError(t, err)
	assert.Equal(t, runner.TelegramUser{ID: 10002, FirstName: "សុខា", LastName: "Chan", Username: "sokha_c", LanguageCode: "zh-hans"}, got)
}

func TestSignInitDataRoundTrip(t *testing.T) {
	initData := runner.SignInitData(initBotToken, sampleTelegramUser(), initNow.Add(-time.Minute))

	values, err := url.ParseQuery(initData)
	require.NoError(t, err)
	assert.ElementsMatch(t, []string{"auth_date", "user", "hash"}, keysOf(values))
	assert.Equal(t, referenceHash(initBotToken, values), values.Get("hash"))

	got, err := runner.VerifyInitData(initData, initBotToken, initNow)
	require.NoError(t, err)
	assert.Equal(t, sampleTelegramUser(), got)
}

func keysOf(values url.Values) []string {
	keys := make([]string, 0, len(values))
	for k := range values {
		keys = append(keys, k)
	}
	return keys
}

func TestVerifyInitDataRejectsTamperedFields(t *testing.T) {
	cases := map[string]func(url.Values){
		"user changed":      func(v url.Values) { v.Set("user", strings.Replace(v.Get("user"), "10001", "10009", 1)) },
		"auth_date changed": func(v url.Values) { v.Set("auth_date", strconv.FormatInt(initNow.Unix(), 10)) },
		"field added":       func(v url.Values) { v.Set("query_id", "AAH-injected") },
		"field removed":     func(v url.Values) { v.Del("user") },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			values := signedValues(t, initNow.Add(-time.Minute))
			mutate(values)

			_, err := runner.VerifyInitData(values.Encode(), initBotToken, initNow)

			requireTelegramAuthInvalid(t, err)
		})
	}
}

func TestVerifyInitDataRejectsExpiredAuthDate(t *testing.T) {
	exactly24h := runner.SignInitData(initBotToken, sampleTelegramUser(), initNow.Add(-24*time.Hour))
	_, err := runner.VerifyInitData(exactly24h, initBotToken, initNow)
	require.NoError(t, err, "距今正好 24 小时仍然有效")

	expired := runner.SignInitData(initBotToken, sampleTelegramUser(), initNow.Add(-24*time.Hour-time.Second))
	_, err = runner.VerifyInitData(expired, initBotToken, initNow)
	requireTelegramAuthInvalid(t, err)
}

func TestVerifyInitDataRejectsMissingOrMalformedHash(t *testing.T) {
	cases := map[string]func(url.Values){
		"missing hash":   func(v url.Values) { v.Del("hash") },
		"empty hash":     func(v url.Values) { v.Set("hash", "") },
		"non hex hash":   func(v url.Values) { v.Set("hash", "zz"+v.Get("hash")[2:]) },
		"duplicate hash": func(v url.Values) { v.Add("hash", v.Get("hash")) },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			values := signedValues(t, initNow.Add(-time.Minute))
			mutate(values)

			_, err := runner.VerifyInitData(values.Encode(), initBotToken, initNow)

			requireTelegramAuthInvalid(t, err)
		})
	}

	for _, raw := range []string{"", "%zz", "not-a-query"} {
		_, err := runner.VerifyInitData(raw, initBotToken, initNow)
		requireTelegramAuthInvalid(t, err)
	}
}

func TestVerifyInitDataRejectsWrongBotToken(t *testing.T) {
	initData := runner.SignInitData("654321:other-bot-token", sampleTelegramUser(), initNow.Add(-time.Minute))

	_, err := runner.VerifyInitData(initData, initBotToken, initNow)
	requireTelegramAuthInvalid(t, err)

	_, err = runner.VerifyInitData(runner.SignInitData("", sampleTelegramUser(), initNow), "", initNow)
	requireTelegramAuthInvalid(t, err)
}

func TestVerifyInitDataRejectsBlankBotToken(t *testing.T) {
	// 空白 token 同样让 secret 成为公开常量，任何人都能伪造登录（Task 1 review 安全项）
	for _, token := range []string{"", " ", "\t\n"} {
		initData := runner.SignInitData(token, sampleTelegramUser(), initNow)
		_, err := runner.VerifyInitData(initData, token, initNow)
		requireTelegramAuthInvalid(t, err)
	}
}

func TestVerifyInitDataRejectsInvalidUser(t *testing.T) {
	for name, user := range map[string]string{
		"not json":   `{"id":`,
		"missing id": `{"first_name":"Dara"}`,
		"zero id":    `{"id":0,"first_name":"Dara"}`,
		"string id":  `{"id":"10001","first_name":"Dara"}`,
		"json array": `[10001]`,
	} {
		t.Run(name, func(t *testing.T) {
			values := url.Values{}
			values.Set("user", user)
			values.Set("auth_date", strconv.FormatInt(initNow.Unix(), 10))
			values.Set("hash", referenceHash(initBotToken, values))

			_, err := runner.VerifyInitData(values.Encode(), initBotToken, initNow)

			requireTelegramAuthInvalid(t, err)
		})
	}
}
