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
		// 报名与收款凭证迭代（spec §8）
		{PermPriceConfig, map[Role]Access{RoleAdmin: AccessRead, RoleOps: AccessWrite, RoleFinance: AccessRead}},
		{PermCouponManage, map[Role]Access{RoleAdmin: AccessRead, RoleOps: AccessWrite, RoleFinance: AccessRead, RoleSupport: AccessRead}},
		{PermPaymentAccountManage, map[Role]Access{RoleAdmin: AccessRead, RoleOps: AccessRead, RoleFinance: AccessWrite}},
		{PermProofReview, map[Role]Access{RoleAdmin: AccessRead, RoleOps: AccessRead, RoleFinance: AccessWrite, RoleSupport: AccessRead}},
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
	assert.Len(t, AllPermissions, 36)
	assert.Len(t, matrix, 36)
	assert.Equal(t,
		[]Permission{PermPriceConfig, PermCouponManage, PermPaymentAccountManage, PermProofReview},
		AllPermissions[32:], "新权限追加在末尾")
	assert.Equal(t, "price_config", string(PermPriceConfig))
	assert.Equal(t, "coupon_manage", string(PermCouponManage))
	assert.Equal(t, "payment_account_manage", string(PermPaymentAccountManage))
	assert.Equal(t, "proof_review", string(PermProofReview))
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
