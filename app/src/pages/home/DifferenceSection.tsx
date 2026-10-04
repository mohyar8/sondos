import DisplayHeading from '../../components/DisplayHeading'
interface Difference {
  readonly title: string
  readonly text: string
}

/**
 * 08-copy-ar §1.3. Each card rests on a verified fact; the deck's line about
 * changing the publishing decision later is left out because that setting
 * does not exist on the site yet.
 */
const differences: readonly Difference[] = [
  {
    title: 'عدسة تفصيلية وهادئة',
    text: 'نلتقط التفاصيل التي تُروى بها القصة: يد الحناء، والخواتم، ونظرة عابرة — لا اللقطات الرسمية فقط.',
  },
  {
    title: 'خصوصيتكِ أولوية لا شعار',
    text: 'صوركِ لا تُنشر في أي مكان، لا في الموقع ولا في حسابات التواصل، إلا بموافقتكِ الصريحة.',
  },
  {
    title: 'سندس بنفسها، من البداية إلى النهاية',
    text: 'تتابعين حجزكِ وتتواصلين مع المصوّرة نفسها التي ستوثّق يومكِ، لا مع فريق مبيعات منفصل.',
  },
  {
    title: 'متابعة واضحة لطلبكِ',
    text: 'تعرفين ما وصل إليه طلبكِ في كل مرحلة من صفحة «حجوزاتي» بعد تسجيل الدخول.',
  },
]

export default function DifferenceSection() {
  return (
    <section
      className="home-difference section"
      aria-labelledby="home-difference-title"
    >
      <div className="container">
        <header className="section-heading reveal">
          <p className="eyebrow">لماذا سندس يار</p>
          <DisplayHeading id="home-difference-title" text="أسلوب مبني على التفاصيل والخصوصية" ornament />
        </header>

        <ul className="home-difference__grid" role="list">
          {differences.map((difference) => (
            <li
              className="card home-difference__card reveal"
              key={difference.title}
            >
              <h3>{difference.title}</h3>
              <p>{difference.text}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
