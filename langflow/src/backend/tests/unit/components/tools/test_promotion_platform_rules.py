import pytest
from lfx.components.tools.promotion_platform_rules import (
    PromotionPlatformRulesComponent,
    build_rules_text,
    select_few_shots,
)

from tests.base import DID_NOT_EXIST, ComponentTestBaseWithoutClient


class TestSelectFewShots:
    def test_douyin_daily_gets_daily_examples_only(self):
        shots = select_few_shots("douyin", "short", "daily")
        assert len(shots) == 3
        assert all(s["batch_kind"] == "daily" for s in shots)

    def test_douyin_milestone_gets_milestone_examples(self):
        assert len(select_few_shots("douyin", "short", "milestone")) == 1

    def test_channels_reuses_douyin_examples(self):
        assert select_few_shots("channels", "short", "daily") == select_few_shots("douyin", "short", "daily")

    def test_moments_short_filters_by_form(self):
        shots = select_few_shots("moments", "short", "milestone")
        assert len(shots) == 3
        assert all(s["form"] == "short" for s in shots)

    def test_moments_both_returns_short_first_then_long(self):
        shots = select_few_shots("moments", "both", "milestone")
        forms = [s["form"] for s in shots]
        assert forms[:3] == ["short"] * 3
        assert forms[3:] == ["long"] * 2

    def test_moments_long_daily_has_no_examples(self):
        assert select_few_shots("moments", "long", "daily") == ()

    def test_moments_both_daily_merges_available_shots(self):
        shots = select_few_shots("moments", "both", "daily")
        assert [s["form"] for s in shots] == ["short"]

    def test_weibo_milestone(self):
        assert len(select_few_shots("weibo", "short", "milestone")) == 3


class TestBuildRulesText:
    def test_douyin_contains_own_spec_not_others(self):
        text = build_rules_text("douyin", "short", "daily")
        assert "信息流折叠文案" in text
        assert "当前平台：抖音（douyin）" in text
        assert "双井号" not in text  # 微博规则不出现
        assert "转发裂变" not in text  # 朋友圈规则不出现
        assert "日常批次" in text

    def test_moments_includes_form_spec(self):
        text = build_rules_text("moments", "long", "milestone")
        assert "长文案形态" in text
        assert "形态：long" in text

    def test_moments_both_includes_both_specs_and_output_order(self):
        text = build_rules_text("moments", "both", "milestone")
        assert "四行文案形态" in text
        assert "长文案形态" in text
        assert "两种形态数量相同、变体编号连续" in text
        assert "〔四行〕" in text
        assert "〔长文〕" in text

    def test_moments_invalid_form_raises(self):
        with pytest.raises(ValueError, match="short / long / both"):
            build_rules_text("moments", "middle", "daily")

    def test_empty_shots_combo_degrades_gracefully(self):
        text = build_rules_text("moments", "long", "daily")
        assert "暂无正例" in text

    def test_unknown_platform_raises(self):
        with pytest.raises(ValueError, match="不支持的平台"):
            build_rules_text("kuaishou", "short", "daily")

    def test_examples_are_current_combo_only(self):
        text = build_rules_text("weibo", "short", "milestone")
        assert "捷报数字当新闻" in text
        assert "一句戏当钩子" not in text  # 抖音正例不出现


class TestPromotionPlatformRulesComponentBasis(ComponentTestBaseWithoutClient):
    @pytest.fixture
    def component_class(self):
        return PromotionPlatformRulesComponent

    @pytest.fixture
    def default_kwargs(self):
        return {"platform": "douyin", "form": "short", "batch_kind": "daily"}

    @pytest.fixture
    def file_names_mapping(self):
        return [
            {"version": "1.0.19", "module": "tools", "file_name": DID_NOT_EXIST},
            {"version": "1.1.0", "module": "tools", "file_name": DID_NOT_EXIST},
            {"version": "1.1.1", "module": "tools", "file_name": DID_NOT_EXIST},
            {"version": "1.13.0", "module": "tools", "file_name": "promotion_platform_rules"},
        ]


class TestPromotionPlatformRulesComponent:
    def test_build_rules_returns_message(self):
        component = PromotionPlatformRulesComponent(platform="weibo", form="short", batch_kind="milestone")
        message = component.build_rules()
        assert "当前平台：微博（weibo）" in message.text
        assert "双井号" in message.text

    def test_status_is_preview(self):
        component = PromotionPlatformRulesComponent(platform="douyin", form="short", batch_kind="daily")
        component.build_rules()
        assert len(component.status) <= 200
