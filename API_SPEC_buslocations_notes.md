# busLocations 필터 명세 검토 메모

## 결론

기존 `GET /api/busLocations/{routeId}`를 유지하고, 쿼리 필터만 추가하는 방향이 가장 단순하다.
대시보드 전용 API를 새로 만들 필요는 없다.

프론트는 출근/퇴근 같은 화면 개념을 API에 넘기지 않고, 실제 조회에 필요한 노선/정류장/시간만 넘긴다.

## 권장 요청 형식

```http
GET /api/busLocations/{routeId}?from=2026-06-01&to=2026-09-13&fromStationSeq=21&toStationSeq=33&startTime=17:00&endTime=17:30
```

## 쿼리 파라미터

| 이름 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `from` | `yyyy-MM-dd` | 예 | 조회 시작일. KST 기준, 포함 |
| `to` | `yyyy-MM-dd` | 예 | 조회 종료일. KST 기준, 포함 |
| `fromStationSeq` | 양의 정수 | 아니오 | 조회 시작 정류장 순번. 포함 |
| `toStationSeq` | 양의 정수 | 아니오 | 조회 종료 정류장 순번. 포함 |
| `startTime` | `HH:mm` | 아니오 | KST 기준 조회 시작 시각. 포함 |
| `endTime` | `HH:mm` | 아니오 | KST 기준 조회 종료 시각. 미만 또는 이하 중 하나로 명세에서 고정 |

## `endTime`을 권장하는 이유

날짜 종료 파라미터가 이미 `to`이므로, 시간 종료도 `toTime`으로 두면 의미가 겹친다.

```text
to=2026-09-13
toTime=17:30
```

보다 아래가 읽기 쉽다.

```text
to=2026-09-13
endTime=17:30
```

## 프론트와 맞춰야 하는 부분

현재 프론트는 내부적으로 시간대를 분 단위로 들고 있다.

```text
17:00 = 1020
17:30 = 1050
```

API가 `startTime/endTime`을 받는다면 프론트에서 요청 직전에 변환하면 된다.

```text
slotStart=1020, slotMinutes=30
→ startTime=17:00, endTime=17:30
```

즉 API에는 `slotStart/slotMinutes`를 굳이 노출하지 않아도 된다.

## 정류장 범위 정책

명세에서 `fromStationSeq > toStationSeq`를 `400 Bad Request`로 둘 수는 있다.
다만 그러면 프론트는 항상 노선 진행 방향 기준으로 작은 seq에서 큰 seq가 되도록 넘겨야 한다.

대안은 API가 내부적으로 아래처럼 처리하는 것이다.

```text
stationSeq BETWEEN min(fromStationSeq, toStationSeq) AND max(fromStationSeq, toStationSeq)
```

하지만 이 경우 `fromStationSeq`와 `toStationSeq`는 실제 탑승/하차 의미라기보다 “조회할 seq 범위”에 가까워진다.
소요시간 매칭까지 서버가 하지 않는 현재 명세라면 둘 중 하나를 명확히 정하는 게 중요하다.

권장안:

```text
1. API는 fromStationSeq <= toStationSeq만 허용한다.
2. 프론트가 출근/퇴근별 실제 노선 진행 방향 seq를 고정해서 넘긴다.
3. 반대 방향 또는 순환 노선 예외가 필요해지면 그때 wrapRange 같은 별도 규칙을 추가한다.
```

## 응답 형식

응답은 기존 형식을 유지하는 것이 좋다.

```json
[
  {
    "plateNo": "서울74바1234",
    "stationSeq": 21,
    "remainSeatCnt": 12,
    "at": "2026-09-13T22:05:00Z"
  }
]
```

프론트는 이미 이 형태를 정규화해서 사용하고 있으므로, 응답 필드를 바꾸지 않는 편이 안전하다.

## 대시보드 책임

아래 값들은 API 명세에 넣지 않는다.

```text
morning/evening
reverse_commute
3330 특수 정류장 제한
요일별 카드 색상 점수
```

이 값들은 대시보드 화면 정책이다.
프론트에서 고정값으로 관리하고 API에는 필터 조건만 보낸다.

## 최소 구현 체크리스트

- `from`, `to`는 필수로 검증한다.
- `routeId`는 정수만 허용한다.
- `fromStationSeq`, `toStationSeq`는 양의 정수만 허용한다.
- `startTime`, `endTime`은 `HH:mm` 형식만 허용한다.
- 시간 필터는 KST 기준으로 적용한다.
- 응답은 시간 오름차순으로 정렬한다.
- 일치하는 이력이 없으면 `[]`를 반환한다.
