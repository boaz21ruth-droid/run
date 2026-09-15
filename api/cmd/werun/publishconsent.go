package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"werun/api/internal/runner"
)

// consentItemArg 是 --items 数组元素的格式，与 disclaimer_versions.items 列一致。
type consentItemArg struct {
	K string `json:"k"`
	T string `json:"t"`
	D string `json:"d"`
}

// runPublishConsent 实现 `werun publish-consent`。参数校验在连接数据库之前完成。
func runPublishConsent(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	in, err := parsePublishConsentArgs(args, stdin, stderr)
	if err != nil {
		return err
	}
	app, err := Bootstrap(ctx)
	if err != nil {
		return err
	}
	defer app.Close()

	if err := app.Runner.PublishConsent(ctx, in); err != nil {
		return describeError(app.Catalog, err)
	}
	_, err = fmt.Fprintf(stdout, "已发布同意书 purpose=%s version=%s lang=%s effective-date=%s items=%d\n",
		in.Purpose, in.Version, in.Lang, in.EffectiveDate.Format(time.DateOnly), len(in.Items))
	return err
}

func parsePublishConsentArgs(args []string, stdin io.Reader, stderr io.Writer) (runner.PublishConsentInput, error) {
	fs := flag.NewFlagSet("publish-consent", flag.ContinueOnError)
	fs.SetOutput(stderr)
	purpose := fs.String("purpose", "", "REGISTRATION | COMMUNITY")
	version := fs.String("version", "", "版本号，如 REG-v1；发布后不可修改")
	lang := fs.String("lang", "", "zh | en | km")
	effective := fs.String("effective-date", "", "生效日期 YYYY-MM-DD")
	file := fs.String("file", "", "正文文件路径；- 表示从标准输入读取")
	items := fs.String("items", "", `勾选项 JSON 数组，如 [{"k":"rules","t":"我已阅读赛事规则","d":"说明，可省略"}]`)
	if err := fs.Parse(args); err != nil {
		return runner.PublishConsentInput{}, err
	}
	if fs.NArg() > 0 {
		return runner.PublishConsentInput{}, fmt.Errorf("多余的参数：%s", strings.Join(fs.Args(), " "))
	}
	for _, required := range []struct{ name, value string }{
		{"--purpose", *purpose},
		{"--version", *version},
		{"--lang", *lang},
		{"--effective-date", *effective},
		{"--file", *file},
		{"--items", *items},
	} {
		if strings.TrimSpace(required.value) == "" {
			return runner.PublishConsentInput{}, fmt.Errorf("缺少 %s", required.name)
		}
	}

	date, err := time.Parse(time.DateOnly, *effective)
	if err != nil {
		return runner.PublishConsentInput{}, fmt.Errorf("--effective-date 必须是 YYYY-MM-DD：%w", err)
	}
	parsedItems, err := parseConsentItems(*items)
	if err != nil {
		return runner.PublishConsentInput{}, err
	}
	text, err := readConsentText(*file, stdin)
	if err != nil {
		return runner.PublishConsentInput{}, err
	}
	return runner.PublishConsentInput{
		Purpose:       *purpose,
		Version:       *version,
		Lang:          *lang,
		EffectiveDate: date,
		FullText:      text,
		Items:         parsedItems,
	}, nil
}

func readConsentText(path string, stdin io.Reader) (string, error) {
	var data []byte
	var err error
	if path == "-" {
		data, err = io.ReadAll(stdin)
	} else {
		data, err = os.ReadFile(path)
	}
	if err != nil {
		return "", fmt.Errorf("读取同意书正文失败：%w", err)
	}
	return string(data), nil
}

func parseConsentItems(raw string) ([]runner.ConsentItem, error) {
	const hint = `--items 必须是一个 JSON 数组，元素形如 {"k":"rules","t":"标题","d":"说明"}`
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	var parsed []consentItemArg
	if err := dec.Decode(&parsed); err != nil {
		return nil, fmt.Errorf("%s：%w", hint, err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, errors.New(hint + "：数组之后还有多余内容")
	}
	items := make([]runner.ConsentItem, len(parsed))
	for i, item := range parsed {
		items[i] = runner.ConsentItem{Key: item.K, Title: item.T, Description: item.D}
	}
	return items, nil
}
