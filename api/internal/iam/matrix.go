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

	// 报名与收款凭证迭代新增（spec §8）
	PermPriceConfig          Permission = "price_config"
	PermCouponManage         Permission = "coupon_manage"
	PermPaymentAccountManage Permission = "payment_account_manage"
	PermProofReview          Permission = "proof_review"
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
	PermPriceConfig,
	PermCouponManage,
	PermPaymentAccountManage,
	PermProofReview,
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

	PermPriceConfig:          row("R", "W", "R", "", "", "", ""),
	PermCouponManage:         row("R", "W", "R", "R", "", "", ""),
	PermPaymentAccountManage: row("R", "R", "W", "", "", "", ""),
	PermProofReview:          row("W", "R", "W", "R", "", "", ""), // 2026-09-24 用户要求 ADMIN 也可审核凭证（偏离 admin.html 矩阵）
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
