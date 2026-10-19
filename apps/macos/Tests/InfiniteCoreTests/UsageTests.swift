import XCTest
@testable import InfiniteCore

/// The cost views decode the host's usage contract as `usage-api.ts` defines it. A missing balance,
/// a subscription without metered spend, and nulls in the scorecard must all decode, never crash.
final class UsageTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    func testOverviewDecodesNullBalanceAndMissingOptionals() throws {
        let overview = try decode(UsageOverview.self, """
        {"period":{"start":"2026-10-01T00:00:00.000Z","end":"2026-11-01T00:00:00.000Z"},"providers":{},
         "month":{"start":"2026-10-01T00:00:00.000Z","end":"2026-11-01T00:00:00.000Z","spent":{"usd":12.84,"unpriced":0},"previous":{"usd":10.9,"unpriced":2},"plansUsd":400,"unmeasuredSessions":3},
         "accounts":[
           {"id":"deepseek","kind":"metered","month":{"usd":8.12,"unpriced":0},"balance":{"amount":12.5,"currency":"USD","asOf":"2026-10-19T08:00:00.000Z","stale":false}},
           {"id":"meta","kind":"metered","month":{"usd":4.72,"unpriced":0},"balance":null},
           {"id":"claude","kind":"subscription","planUsd":200,"balance":null},
           {"id":"codex","kind":"subscription","balance":null}]}
        """)
        XCTAssertEqual(overview.month.spent, Money(usd: 12.84, unpriced: 0))
        XCTAssertEqual(overview.month.previous.unpriced, 2)
        XCTAssertEqual(overview.withPlansUsd, 412.84, accuracy: 0.0001)
        XCTAssertEqual(overview.accounts.map(\.id), ["deepseek", "meta", "claude", "codex"])
        XCTAssertEqual(overview.accounts[0].balance?.amount, 12.5)
        XCTAssertNil(overview.accounts[1].balance)
        XCTAssertNil(overview.accounts[2].month)
        XCTAssertEqual(overview.accounts[2].planUsd, 200)
        XCTAssertNil(overview.accounts[3].planUsd)
        XCTAssertFalse(overview.accounts[2].metered)
    }

    /// The desktop client receives `JSON` values; the typed contract comes from re-encoding them.
    func testContractDecodesFromTheClientJSONValue() throws {
        let value = try JSON.parse(Data("""
        {"tz":"Europe/Berlin","accounts":["deepseek","meta"],"days":[{"date":"2026-10-18","usd":1.5,"byAccount":{"deepseek":1,"meta":0.5}},{"date":"2026-10-19","usd":0,"byAccount":{}}]}
        """.utf8))
        let daily: DailyUsage = try value.decoded()
        XCTAssertEqual(daily.days.count, 2)
        XCTAssertEqual(daily.days[0].byAccount["meta"], 0.5)
        XCTAssertEqual(daily.days[1].byAccount, [:])
        XCTAssertEqual(daily.maxUsd, 1.5)
    }

    func testProjectDecodesTeamsWithoutAGoal() throws {
        let project = try decode(ProjectUsage.self, """
        {"id":"p1","name":"Infinite","total":{"usd":41.2,"unpriced":3},
         "byKind":{"goals":1,"teams":2,"sessions":1,"briefings":4},
         "goals":[{"id":"g1","title":"Ship cost view","total":{"usd":30,"unpriced":0},"tasks":6}],
         "teams":[{"id":"t1","title":"Cost view","goalId":"g1","total":{"usd":30,"unpriced":0}},{"id":"t2","title":"Fix lint","total":{"usd":1.2,"unpriced":3}}],
         "sessions":[{"id":"s1","title":"Chat","total":{"usd":0.4,"unpriced":0}}],
         "briefings":{"total":{"usd":9.6,"unpriced":0},"runs":4,"unmeasured":1}}
        """)
        XCTAssertEqual(project.teams[0].goalId, "g1")
        XCTAssertNil(project.teams[1].goalId)
        XCTAssertTrue(project.total.isFloor)
        XCTAssertEqual(project.total.label, "≥ $41.20")
        XCTAssertEqual(project.briefings.unmeasured, 1)
        let list = try decode(UsageProjects.self, """
        {"projects":[{"id":"p1","name":"Infinite","total":{"usd":41.2,"unpriced":0},"month":{"usd":12,"unpriced":0},"spark":[0,0,1.5,0.25]}]}
        """)
        XCTAssertEqual(list.projects[0].spark, [0, 0, 1.5, 0.25])
    }

    func testScorecardDecodesNullsForSubscriptionAndSmallSamples() throws {
        let card = try decode(Scorecard.self, """
        {"rubricVersion":1,"minAttempts":10,
         "rows":[
           {"profileId":"luna","label":"Luna","provider":"opencode","role":"implementer","metered":true,"attempts":34,"integrated":31,"rate":0.91,"rateInterval":[0.77,0.97],
            "medianUsd":0.42,"medianTokens":31000,"usdPerMTok":13.5,"medianMinutes":14,"meanReviewRounds":1.2,
            "rubric":{"correctness":4.2,"cleanliness":4.0,"extensibility":4.1,"docs":3.9,"n":12},"owner":{"mean":4.5,"n":3},"enough":true},
           {"profileId":"haiku","label":"Haiku","provider":"claude","role":"implementer","metered":false,"attempts":1,"integrated":1,"rate":1,"rateInterval":null,
            "medianUsd":null,"medianTokens":null,"usdPerMTok":null,"medianMinutes":null,"meanReviewRounds":null,"rubric":null,"owner":null,"enough":false}],
         "suggestions":[{"text":"Luna integrated 31/34 implementer tasks at a median $0.42; Haiku 29/33","profileId":"luna","comparedTo":"haiku","role":"implementer","n":[34,33]}]}
        """)
        XCTAssertEqual(card.rows.count, 2)
        XCTAssertEqual(card.rows[0].interval?.low, 0.77)
        XCTAssertEqual(card.rows[0].rubric?.mean ?? 0, 4.05, accuracy: 0.0001)
        XCTAssertNil(card.rows[1].interval)
        XCTAssertNil(card.rows[1].medianUsd)
        XCTAssertNil(card.rows[1].rubric)
        XCTAssertFalse(card.rows[1].enough)
        XCTAssertEqual(card.roles, ["implementer"])
        XCTAssertEqual(card.suggestions[0].n, [34, 33])
    }

    func testTaskUsageAndRatingOnATeamTask() throws {
        let task = try JSON.parse(Data("""
        {"id":"t1","usage":{"usd":0.42,"unpriced":1,"tokens":31400,"attempts":2,"profiles":["luna","haiku"]},"ownerRating":{"score":4,"at":"2026-10-19T08:00:00.000Z"}}
        """.utf8))
        let usage: TaskUsage = try task["usage"].decoded()
        XCTAssertEqual(usage.money.label, "≥ $0.42")
        XCTAssertEqual(usage.attempts, 2)
        let rating: OwnerRating = try task["ownerRating"].decoded()
        XCTAssertEqual(rating.score, 4)
        XCTAssertNil(rating.note)
    }

    func testFiguresStayShort() {
        XCTAssertEqual(UsageFormat.usd(0.4216), "$0.42")
        XCTAssertEqual(UsageFormat.usd(12.5), "$12.50")
        XCTAssertEqual(UsageFormat.usd(1284.4), "$1,284")
        XCTAssertEqual(UsageFormat.usd(12_940), "$12.9K")
        XCTAssertEqual(UsageFormat.usd(1_200_000), "$1.2M")
        XCTAssertEqual(UsageFormat.usd(0), "$0.00")
        XCTAssertEqual(UsageFormat.tokens(640), "640")
        XCTAssertEqual(UsageFormat.tokens(3_140), "3.1K")
        XCTAssertEqual(UsageFormat.tokens(31_400), "31K")
        XCTAssertEqual(UsageFormat.tokens(1_260_000), "1.3M")
        XCTAssertEqual(UsageFormat.delta(12.84, previous: 10.9), "+18%")
        XCTAssertEqual(UsageFormat.delta(9, previous: 10), "−10%")
        XCTAssertEqual(UsageFormat.delta(10, previous: 10), "0%")
        XCTAssertNil(UsageFormat.delta(5, previous: 0))
        XCTAssertEqual(UsageFormat.percent(0.912), "91%")
        XCTAssertEqual(UsageFormat.balance(Balance(amount: 12.5, currency: "USD", asOf: "", stale: false)), "$12.50")
        XCTAssertEqual(UsageFormat.balance(Balance(amount: 80, currency: "CNY", asOf: "", stale: true)), "80.00 CNY")
        XCTAssertEqual(Money(usd: 3, unpriced: 0).label, "$3.00")
    }
}
