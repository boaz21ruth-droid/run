// Package jobs 定义后台任务（River）以及它们的调度方式。
package jobs

import "time"

// DailyAt 是 River 的 PeriodicSchedule：每天在 Loc 时区的 Hour:Minute 触发一次。
type DailyAt struct {
	Hour, Minute int
	Loc          *time.Location
}

// Next 返回严格晚于 current 的下一个触发时刻。
func (d DailyAt) Next(current time.Time) time.Time {
	loc := d.Loc
	if loc == nil {
		loc = time.UTC
	}
	local := current.In(loc)
	next := time.Date(local.Year(), local.Month(), local.Day(), d.Hour, d.Minute, 0, 0, loc)
	if !next.After(local) {
		// time.Date 会自动把 Day+1 规范化到下个月或下一年
		next = time.Date(local.Year(), local.Month(), local.Day()+1, d.Hour, d.Minute, 0, 0, loc)
	}
	return next
}
