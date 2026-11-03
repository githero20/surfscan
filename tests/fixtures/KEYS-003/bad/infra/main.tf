resource "aws_iam_role_policy_attachment" "agent" {
  role       = aws_iam_role.agent.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}
