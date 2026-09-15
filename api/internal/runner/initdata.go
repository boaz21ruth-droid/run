package runner

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"werun/api/internal/platform/apperr"
)

// initDataMaxAge：auth_date 距今超过这个时长即视为过期（Global Constraints）。
const initDataMaxAge = 24 * time.Hour

type telegramUserJSON struct {
	ID           int64  `json:"id"`
	FirstName    string `json:"first_name"`
	LastName     string `json:"last_name,omitempty"`
	Username     string `json:"username,omitempty"`
	LanguageCode string `json:"language_code,omitempty"`
}

// VerifyInitData 按 Telegram Mini App 规则校验 initData：
// secret = HMAC_SHA256(key="WebAppData", msg=botToken)；
// hash = hex(HMAC_SHA256(key=secret, msg=data_check_string))；
// data_check_string 为除 hash 外所有字段按键名排序后以 \n 连接的 key=value（值为 URL 解码后的原文）。
func VerifyInitData(initData, botToken string, now time.Time) (TelegramUser, error) {
	// 空（或空白）token 让 secret 成为公开常量，任何人都能签出合法的 initData
	if strings.TrimSpace(botToken) == "" {
		return TelegramUser{}, telegramAuthInvalid("bot token is empty")
	}
	values, err := url.ParseQuery(initData)
	if err != nil {
		return TelegramUser{}, telegramAuthInvalid("parse init data: %v", err)
	}
	for key, v := range values {
		if len(v) != 1 {
			return TelegramUser{}, telegramAuthInvalid("field %q appears %d times", key, len(v))
		}
	}
	gotHex := values.Get("hash")
	if gotHex == "" {
		return TelegramUser{}, telegramAuthInvalid("missing hash")
	}
	got, err := hex.DecodeString(gotHex)
	if err != nil {
		return TelegramUser{}, telegramAuthInvalid("hash is not hex: %v", err)
	}
	if !hmac.Equal(got, initDataHash(botToken, dataCheckString(values))) {
		return TelegramUser{}, telegramAuthInvalid("hash mismatch")
	}

	authUnix, err := strconv.ParseInt(values.Get("auth_date"), 10, 64)
	if err != nil {
		return TelegramUser{}, telegramAuthInvalid("invalid auth_date %q", values.Get("auth_date"))
	}
	if now.Sub(time.Unix(authUnix, 0)) > initDataMaxAge {
		return TelegramUser{}, telegramAuthInvalid("auth_date %d expired", authUnix)
	}

	var u telegramUserJSON
	if err := json.Unmarshal([]byte(values.Get("user")), &u); err != nil {
		return TelegramUser{}, telegramAuthInvalid("decode user: %v", err)
	}
	if u.ID <= 0 {
		return TelegramUser{}, telegramAuthInvalid("user id missing")
	}
	return TelegramUser(u), nil
}

// SignInitData 生成含 auth_date、user、hash 的 initData 查询串。只用于 dev-initdata 与测试。
func SignInitData(botToken string, u TelegramUser, authDate time.Time) string {
	// 字段都是字符串和整数，json.Marshal 不会失败
	userJSON, _ := json.Marshal(telegramUserJSON(u))
	values := url.Values{}
	values.Set("auth_date", strconv.FormatInt(authDate.Unix(), 10))
	values.Set("user", string(userJSON))
	values.Set("hash", hex.EncodeToString(initDataHash(botToken, dataCheckString(values))))
	return values.Encode()
}

func dataCheckString(values url.Values) string {
	keys := make([]string, 0, len(values))
	for key := range values {
		if key != "hash" {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	lines := make([]string, len(keys))
	for i, key := range keys {
		lines[i] = key + "=" + values.Get(key)
	}
	return strings.Join(lines, "\n")
}

func initDataHash(botToken, checkString string) []byte {
	secret := hmac.New(sha256.New, []byte("WebAppData"))
	_, _ = secret.Write([]byte(botToken))
	mac := hmac.New(sha256.New, secret.Sum(nil))
	_, _ = mac.Write([]byte(checkString))
	return mac.Sum(nil)
}

// telegramAuthInvalid 返回 401 TELEGRAM_AUTH_INVALID；具体原因只进日志，不返回给前端。
func telegramAuthInvalid(format string, args ...any) *apperr.Error {
	return apperr.New(http.StatusUnauthorized, apperr.CodeTelegramAuthInvalid).
		Wrap(fmt.Errorf("runner: init data invalid: "+format, args...))
}
